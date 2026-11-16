import { networkInterfaces } from 'node:os';

export type LocalSubnet = { name: string; address: string; cidr: string; prefix: number };

const SKIPPED_INTERFACE = /^(lo|docker|br-|veth|virbr|tun|tap|zt)/i;

export function isPrivateIpv4(ip: string) {
  const parts = ipv4Parts(ip);
  if (!parts) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

export function ipv4Parts(ip: string) {
  const parts = ip.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts;
}

export function prefixFromNetmask(netmask: string) {
  const parts = ipv4Parts(netmask);
  if (!parts) return null;
  const bits = parts.map((part) => part.toString(2).padStart(8, '0')).join('');
  if (!/^1*0*$/.test(bits)) return null;
  return bits.indexOf('0') === -1 ? 32 : bits.indexOf('0');
}

export function localSubnets() {
  const found: LocalSubnet[] = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    if (SKIPPED_INTERFACE.test(name)) continue;
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== 'IPv4') continue;
      const prefix = prefixFromNetmask(entry.netmask);
      if (!prefix || !isPrivateIpv4(entry.address)) continue;
      const parts = ipv4Parts(entry.address);
      if (!parts) continue;
      const address = networkAddress(parts, prefix);
      found.push({ name, address: entry.address, cidr: `${address}/${prefix}`, prefix });
    }
  }
  return found;
}

export function networkAddress(parts: number[], prefix: number) {
  const bits = parts.map((part) => part.toString(2).padStart(8, '0')).join('').slice(0, prefix).padEnd(32, '0');
  return [0, 8, 16, 24].map((start) => parseInt(bits.slice(start, start + 8), 2)).join('.');
}

/** Usable host addresses. Rejects public ranges and scans larger than maxHosts. */
export function expandPrivateCidr(cidr: string, maxHosts = 1024) {
  const match = cidr.trim().match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
  if (!match) throw new Error('Subnet must look like 192.168.1.0/24');
  const prefix = Number(match[2]);
  const parts = ipv4Parts(match[1]);
  if (!parts || prefix < 22 || prefix > 30) throw new Error('Scan a private subnet between /30 and /22');
  const base = networkAddress(parts, prefix);
  const baseParts = ipv4Parts(base);
  if (!baseParts || !isPrivateIpv4(base)) throw new Error('Only private LAN subnets can be scanned');
  const hostCount = 2 ** (32 - prefix) - 2;
  if (hostCount > maxHosts) throw new Error(`That subnet has ${hostCount} hosts. Scan a block of ${maxHosts} or fewer.`);
  const hosts: string[] = [];
  const start = ((baseParts[0] << 24) | (baseParts[1] << 16) | (baseParts[2] << 8) | baseParts[3]) >>> 0;
  for (let offset = 1; offset <= hostCount; offset += 1) {
    const value = (start + offset) >>> 0;
    hosts.push([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.'));
  }
  return { cidr: `${base}/${prefix}`, hosts };
}
