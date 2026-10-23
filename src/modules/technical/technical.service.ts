import { Injectable } from '@nestjs/common';
import { statfs, readFile } from 'node:fs/promises';
import { cpus, freemem, totalmem, uptime } from 'node:os';
import { PrismaService } from '../../utils/prisma/prisma.service';

type ServiceState = 'online' | 'offline' | 'not_configured';

@Injectable()
export class TechnicalService {
  private previousNetwork?: { received: number; sent: number; at: number };

  constructor(private readonly prisma: PrismaService) {}

  async getStatus() {
    const [database, nginx, disk, network, cpuPercent] = await Promise.all([
      this.checkDatabase(), this.checkNginx(), this.getDiskUsage(), this.getNetworkUsage(), this.getCpuUsage(),
    ]);
    const memoryTotal = totalmem();
    const memoryUsed = memoryTotal - freemem();
    return {
      checkedAt: new Date().toISOString(),
      services: {
        backend: { status: 'online' as const, uptimeSeconds: Math.floor(uptime()), processUptimeSeconds: Math.floor(process.uptime()) },
        postgresql: database,
        nginx,
      },
      resources: {
        cpu: { usagePercent: cpuPercent, cores: cpus().length },
        memory: { usedBytes: memoryUsed, totalBytes: memoryTotal, usagePercent: memoryTotal ? Math.round(memoryUsed / memoryTotal * 100) : 0 },
        disk,
        network,
      },
    };
  }

  private async checkDatabase(): Promise<{ status: ServiceState; latencyMs: number | null }> {
    const start = Date.now();
    try { await this.prisma.$queryRaw`SELECT 1`; return { status: 'online', latencyMs: Date.now() - start }; }
    catch { return { status: 'offline', latencyMs: null }; }
  }

  private async checkNginx(): Promise<{ status: ServiceState; responseMs: number | null; message?: string }> {
    const url = process.env.NGINX_STATUS_URL;
    if (!url) return { status: 'not_configured', responseMs: null, message: 'Set NGINX_STATUS_URL to an internal Nginx stub_status URL.' };
    const start = Date.now();
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
      return { status: response.ok ? 'online' : 'offline', responseMs: Date.now() - start };
    } catch { return { status: 'offline', responseMs: null }; }
  }

  private async getDiskUsage() {
    try {
      const info = await statfs(process.cwd());
      const totalBytes = info.blocks * info.bsize;
      const availableBytes = info.bavail * info.bsize;
      const usedBytes = totalBytes - availableBytes;
      return { status: 'online' as const, path: process.cwd(), totalBytes, usedBytes, availableBytes, usagePercent: totalBytes ? Math.round(usedBytes / totalBytes * 100) : 0 };
    } catch { return { status: 'offline' as const, path: process.cwd(), totalBytes: 0, usedBytes: 0, availableBytes: 0, usagePercent: 0 }; }
  }

  private async getNetworkUsage() {
    try {
      const content = await readFile('/proc/net/dev', 'utf8');
      const totals = content.split('\n').slice(2).reduce((sum, line) => {
        const [name, values] = line.trim().split(':');
        if (!values || name.trim() === 'lo') return sum;
        const counters = values.trim().split(/\s+/).map(Number);
        return { received: sum.received + (counters[0] || 0), sent: sum.sent + (counters[8] || 0) };
      }, { received: 0, sent: 0 });
      const now = Date.now();
      const elapsedSeconds = this.previousNetwork ? (now - this.previousNetwork.at) / 1000 : 0;
      const receivedBytesPerSecond = elapsedSeconds ? Math.max(0, totals.received - this.previousNetwork!.received) / elapsedSeconds : 0;
      const sentBytesPerSecond = elapsedSeconds ? Math.max(0, totals.sent - this.previousNetwork!.sent) / elapsedSeconds : 0;
      this.previousNetwork = { ...totals, at: now };
      return { status: 'online' as const, receivedBytes: totals.received, sentBytes: totals.sent, receivedBytesPerSecond: Math.round(receivedBytesPerSecond), sentBytesPerSecond: Math.round(sentBytesPerSecond) };
    } catch { return { status: 'offline' as const, receivedBytes: 0, sentBytes: 0, receivedBytesPerSecond: 0, sentBytesPerSecond: 0 }; }
  }

  private async getCpuUsage(): Promise<number> {
    const readCounters = () => cpus().reduce((sum, cpu) => ({ idle: sum.idle + cpu.times.idle, total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 });
    const before = readCounters();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const after = readCounters();
    const totalDelta = after.total - before.total;
    return totalDelta ? Math.round((1 - (after.idle - before.idle) / totalDelta) * 100) : 0;
  }
}
