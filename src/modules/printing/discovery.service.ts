import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { connect as connectTcp } from 'node:net';
import { readFile } from 'node:fs/promises';
import { classifyDevice, type ClassifiedDevice } from './classify';
import { expandPrivateCidr, localSubnets } from './network';
import { querySnmp } from './snmp';

export type ScanOptions = { subnet?: string; methods?: Array<'arp' | 'mdns' | 'snmp' | 'tcp'>; timeoutMs?: number };

type HostSeed = { ip: string; macAddress?: string; hostname?: string; vendor?: string; openPorts: number[]; snmpText?: string };

@Injectable()
export class DiscoveryService {
  private readonly logger = new Logger(DiscoveryService.name);
  private scan: { scanning: boolean; subnet: string; scanned: number; total: number; devices: ClassifiedDevice[]; error?: string; finishedAt?: string } = {
    scanning: false, subnet: '', scanned: 0, total: 0, devices: [],
  };

  results() { return this.scan; }

  printers() { return this.scan.devices.filter((device) => device.deviceType === 'printer'); }

  device(ip: string) { return this.scan.devices.find((device) => device.ip === ip) ?? null; }

  async start(options: ScanOptions) {
    if (this.scan.scanning) return this.scan;
    const chosen = options.subnet?.trim() || localSubnets()[0]?.cidr;
    if (!chosen) throw new Error('No private network interface was found. Enter a subnet such as 192.168.1.0/24.');
    const range = expandPrivateCidr(chosen);
    const methods = new Set(options.methods?.length ? options.methods : ['arp', 'mdns', 'snmp', 'tcp']);
    const timeoutMs = options.timeoutMs ?? 400;
    this.scan = { scanning: true, subnet: range.cidr, scanned: 0, total: range.hosts.length, devices: [] };
    void this.run(range.hosts, methods, timeoutMs).catch((error: unknown) => {
      this.scan.scanning = false;
      this.scan.error = error instanceof Error ? error.message : 'Network scan failed';
      this.logger.warn(this.scan.error);
    });
    return this.scan;
  }

  private async run(hosts: string[], methods: Set<string>, timeoutMs: number) {
    const byIp = new Map<string, HostSeed>();
    const remember = (ip: string, patch: Partial<HostSeed>) => {
      const current = byIp.get(ip) ?? { ip, openPorts: [] };
      byIp.set(ip, { ...current, ...patch, openPorts: [...new Set([...current.openPorts, ...(patch.openPorts ?? [])])] });
    };
    if (methods.has('arp')) {
      const arp = await this.arpScan(this.scan.subnet);
      arp.forEach((row) => remember(row.ip, row));
      if (!arp.length) {
        await this.pingSweep(hosts);
        (await this.readArpTable()).forEach((row) => remember(row.ip, row));
      }
    }
    if (methods.has('mdns')) (await this.mdns()).forEach((row) => remember(row.ip, row));
    const portTargets = methods.has('tcp') ? hosts : [...byIp.keys()];
    await this.mapPool(portTargets, 64, async (ip) => {
      const ports = await this.openPorts(ip, methods.has('tcp') ? [9100, 631, 515, 80, 443] : [9100], timeoutMs);
      if (ports.length || byIp.has(ip)) remember(ip, { openPorts: ports });
      this.scan.scanned += 1;
    });
    if (methods.has('snmp')) {
      await this.mapPool([...byIp.keys()], 16, async (ip) => {
        const text = await querySnmp(ip, timeoutMs);
        if (text) remember(ip, { snmpText: text });
      });
    }
    this.scan.devices = [...byIp.values()]
      .map((host) => classifyDevice(host))
      .sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
    this.scan.scanning = false;
    this.scan.finishedAt = new Date().toISOString();
  }

  private arpScan(cidr: string) {
    return new Promise<HostSeed[]>((resolve) => {
      const child = spawn('arp-scan', ['--plain', '--ignoredups', '--timeout=300', '--retry=1', cidr], { timeout: 20_000 });
      let output = '';
      const done = (rows: HostSeed[]) => resolve(rows);
      child.once('error', () => done([]));
      child.stdout?.on('data', (chunk) => { output += String(chunk); });
      child.once('close', () => {
        done(output.split('\n').flatMap((line) => {
          const [ip, mac, ...vendor] = line.trim().split('\t');
          if (!ip || !mac) return [];
          return [{ ip, macAddress: mac, vendor: vendor.join(' '), openPorts: [] }];
        }));
      });
    });
  }

  private pingSweep(hosts: string[]) {
    return this.mapPool(hosts, 40, (ip) => new Promise<void>((resolve) => {
      const child = spawn('ping', ['-c', '1', '-W', '1', ip], { timeout: 1500 });
      child.once('error', () => resolve());
      child.once('close', () => resolve());
    }));
  }

  private async readArpTable() {
    const rows: HostSeed[] = [];
    try {
      const table = await readFile('/proc/net/arp', 'utf8');
      for (const line of table.split('\n').slice(1)) {
        const [ip, , , mac] = line.trim().split(/\s+/);
        if (!ip || !mac || mac === '00:00:00:00:00:00') continue;
        rows.push({ ip, macAddress: mac, openPorts: [] });
      }
    } catch { /* ARP table is not available on this host. */ }
    return rows;
  }

  private mdns() {
    return new Promise<HostSeed[]>((resolve) => {
      const found = new Map<string, HostSeed>();
      const socket = createSocket({ type: 'udp4', reuseAddr: true });
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.close();
        resolve([...found.values()]);
      };
      const timer = setTimeout(finish, 1500);
      socket.once('error', finish);
      socket.on('message', (message, remote) => {
        const text = message.toString('utf8').replace(/[^\x20-\x7e]/g, ' ');
        const current = found.get(remote.address) ?? { ip: remote.address, openPorts: [], hostname: '' };
        current.hostname = text.match(/[A-Za-z0-9-]{2,}\.local/)?.[0] ?? current.hostname;
        if (/epson|tm-|printer|ipp/i.test(text)) current.vendor = current.vendor || 'Printer service';
        found.set(remote.address, current);
      });
      socket.bind(0, () => {
        socket.addMembership('224.0.0.251');
        for (const name of ['_ipp._tcp.local', '_ipps._tcp.local', '_printer._tcp.local', '_pdl-datastream._tcp.local']) {
          socket.send(dnsQuery(name), 5353, '224.0.0.251');
        }
      });
    });
  }

  private openPorts(ip: string, ports: number[], timeoutMs: number) {
    return Promise.all(ports.map((port) => probe(ip, port, timeoutMs).then((open) => open ? port : 0))).then((result) => result.filter((port) => port > 0));
  }

  private async mapPool<T>(items: T[], limit: number, task: (item: T) => Promise<unknown>) {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const item = items[cursor];
        cursor += 1;
        await task(item);
      }
    });
    await Promise.all(workers);
  }
}

function probe(ip: string, port: number, timeoutMs: number) {
  return new Promise<boolean>((resolve) => {
    const socket = connectTcp({ host: ip, port });
    const finish = (open: boolean) => { clearTimeout(timer); socket.destroy(); resolve(open); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function dnsQuery(name: string) {
  const labels = Buffer.concat(name.split('.').map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])));
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 4);
  return Buffer.concat([header, labels, Buffer.from([0, 0, 12, 0, 1])]);
}
