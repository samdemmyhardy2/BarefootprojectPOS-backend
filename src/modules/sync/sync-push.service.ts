import { ConflictException, HttpException, Injectable, Logger, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { gzipSync } from 'node:zlib';
import { PrismaService } from '../../utils/prisma/prisma.service';
import { quote, schemaVersion, syncRole, syncTables } from './sync-tables';

const TICK_MS = 5_000;
const IDLE_PING_MS = 60_000;
const BATCH = 500;
const FULL_KEY = 'fullSyncedAt';

type Change = { id: string; table: string; op: 'U' | 'D'; row: Record<string, unknown> };

/**
 * Runs on the restaurant laptop. Every database change is stored in SyncChange by a trigger. While the server is
 * unreachable the changes wait there; every few seconds the laptop pings the server and, when it answers, pushes them in
 * order. The first sync sends a full copy, which makes the server match the laptop exactly.
 */
@Injectable()
export class SyncPushService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SyncPushService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private online: boolean | null = null;
  private lastPingAt: Date | null = null;
  private lastPushAt: Date | null = null;
  private lastError: string | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    // Covers tables added by migrations after the sync migration, on the laptop and the server alike.
    await this.prisma.$executeRawUnsafe('SELECT sync_install_triggers()').catch((error: unknown) => this.logger.warn(`Could not install sync triggers: ${error instanceof Error ? error.message : String(error)}`));
    if (syncRole() !== 'client') {
      // Nothing reads the change log here, so keep it from growing.
      await this.prisma.syncChange.deleteMany().catch(() => undefined);
      return;
    }
    this.logger.log(`Server sync is on: pushing changes to ${this.serverUrl()}.`);
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private serverUrl() {
    return (process.env.SYNC_SERVER_URL ?? '').trim().replace(/\/+$/, '');
  }

  private async request<T>(path: string, init: RequestInit = {}, timeoutMs = 10_000) {
    const response = await fetch(`${this.serverUrl()}/sync/receive/${path}`, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${process.env.SYNC_TOKEN?.trim() ?? ''}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.json().catch(() => null) as (T & { message?: unknown }) | null;
    if (!response.ok) {
      const message = Array.isArray(body?.message) ? body.message.join(', ') : typeof body?.message === 'string' ? body.message : `HTTP ${response.status}`;
      throw new ServerError(message, response.status);
    }
    return body as T;
  }

  private send<T>(path: string, payload: unknown, timeoutMs: number) {
    return this.request<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, body: gzipSync(JSON.stringify(payload)) }, timeoutMs);
  }

  private async pending() {
    return this.prisma.syncChange.count();
  }

  private async fullSyncedAt() {
    return (await this.prisma.syncState.findUnique({ where: { key: FULL_KEY } }))?.value ?? null;
  }

  async status() {
    const role = syncRole();
    if (role !== 'client') return { role };
    let host = this.serverUrl();
    try { host = new URL(host).host; } catch { /* Shown as configured. */ }
    return {
      role,
      server: host,
      online: this.online,
      syncing: this.running !== null,
      pending: await this.pending(),
      fullSyncedAt: await this.fullSyncedAt(),
      lastPingAt: this.lastPingAt,
      lastPushAt: this.lastPushAt,
      lastError: this.lastError,
    };
  }

  private async tick() {
    if (this.running) return;
    try {
      const idle = (await this.pending()) === 0 && (await this.fullSyncedAt()) !== null;
      if (idle && this.lastPingAt && Date.now() - this.lastPingAt.getTime() < IDLE_PING_MS) return;
      await this.sync(false, idle);
    } catch {
      // The error is kept in lastError and shown in the app.
    }
  }

  /** Pings the server, then sends a full copy when needed and any waiting changes. */
  sync(full: boolean, pingOnly = false) {
    this.running ??= this.run(full, pingOnly).finally(() => { this.running = null; });
    return this.running.then(() => this.status());
  }

  private async run(full: boolean, pingOnly: boolean) {
    if (syncRole() !== 'client') throw new ServiceUnavailableException('Server sync is not configured on this backend.');
    try {
      const server = await this.request<{ schema: string }>('ping', {}, 5_000);
      this.online = true;
      this.lastPingAt = new Date();
      const version = await schemaVersion(this.prisma);
      if (server.schema !== version) throw new ConflictException(`The server database is at migration ${server.schema || 'none'} but this laptop is at ${version || 'none'}. Run the same migrations on the server.`);
      if (pingOnly) { this.lastError = null; return; }
      if (full || !(await this.fullSyncedAt())) await this.pushFull(version);
      await this.pushChanges(version);
      this.lastError = null;
    } catch (error) {
      if (!(error instanceof ServerError) && !(error instanceof ConflictException)) this.online = false;
      this.lastError = error instanceof Error ? error.message : 'Sync failed';
      if (this.online === false) this.lastError = `The server cannot be reached. Changes are kept on this laptop and sent when it answers. (${this.lastError})`;
      if (error instanceof HttpException) throw error;
      // The Sync button shows this message, so it must say what happened rather than a generic server error.
      throw new ServiceUnavailableException(this.lastError);
    }
  }

  /** Snapshot of every table taken in one consistent read; the changes it already contains are then cleared. */
  private async pushFull(version: string) {
    const snapshot = await this.prisma.$transaction(async (tx) => {
      const ids = (await tx.$queryRawUnsafe<{ id: string }[]>(`SELECT id::text AS id FROM "SyncChange"`)).map((row) => row.id);
      const tables: { name: string; rows: Record<string, unknown>[] }[] = [];
      for (const table of await syncTables(tx)) {
        const [result] = await tx.$queryRawUnsafe<{ rows: Record<string, unknown>[] }[]>(`SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS rows FROM ${quote(table.name)} t`);
        tables.push({ name: table.name, rows: result.rows });
      }
      return { ids, tables };
    }, { isolationLevel: 'RepeatableRead', timeout: 120_000 });
    const result = await this.send<{ rows: number }>('full', { schema: version, tables: snapshot.tables }, 300_000);
    for (let at = 0; at < snapshot.ids.length; at += 5_000) await this.prisma.$executeRawUnsafe(`DELETE FROM "SyncChange" WHERE id = ANY($1::bigint[])`, snapshot.ids.slice(at, at + 5_000));
    const now = new Date().toISOString();
    await this.prisma.syncState.upsert({ where: { key: FULL_KEY }, create: { key: FULL_KEY, value: now }, update: { value: now } });
    this.lastPushAt = new Date();
    this.logger.log(`Sent a full copy to the server: ${result.rows} rows.`);
  }

  private async pushChanges(version: string) {
    for (;;) {
      const changes = await this.prisma.$queryRawUnsafe<Change[]>(`SELECT id::text AS id, "table", op, "row" FROM "SyncChange" ORDER BY id LIMIT ${BATCH}`);
      if (!changes.length) return;
      const result = await this.send<{ applied: string[] }>('changes', { schema: version, changes }, 120_000);
      await this.prisma.$executeRawUnsafe(`DELETE FROM "SyncChange" WHERE id = ANY($1::bigint[])`, result.applied);
      this.lastPushAt = new Date();
    }
  }
}

/** The server answered but refused; it is online, so this is not a connection problem. */
class ServerError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}
