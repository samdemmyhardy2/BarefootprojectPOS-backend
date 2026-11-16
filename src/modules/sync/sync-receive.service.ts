import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../utils/prisma/prisma.service';
import { quote, schemaVersion, syncTables, type TableInfo } from './sync-tables';

export type PushedChange = { id: string; table: string; op: 'U' | 'D'; row: Record<string, unknown> };
const CHUNK = 500;

/** Runs on the hosted server: writes what the restaurant laptop pushes, so the server stays an exact copy. */
@Injectable()
export class SyncReceiveService {
  private readonly logger = new Logger(SyncReceiveService.name);
  private tables: Map<string, TableInfo> | null = null;
  private lastReceivedAt: Date | null = null;

  constructor(private readonly prisma: PrismaService) {}

  private async known() {
    this.tables ??= new Map((await syncTables(this.prisma)).map((table) => [table.name, table]));
    return this.tables;
  }

  private async checkVersion(version: string) {
    const mine = await schemaVersion(this.prisma);
    if (version !== mine) throw new ConflictException(`The server database is at migration ${mine || 'none'} but the laptop is at ${version || 'none'}. Run the same migrations on both.`);
  }

  async ping() {
    return { ok: true, schema: await schemaVersion(this.prisma), lastReceivedAt: this.lastReceivedAt };
  }

  /** Replaces every application table with the laptop's copy, in one transaction. */
  async full(version: string, tables: { name: string; rows: Record<string, unknown>[] }[]) {
    await this.checkVersion(version);
    const known = await this.known();
    for (const table of tables) if (!known.has(table.name)) throw new BadRequestException(`Unknown table ${table.name}`);
    const order = [...known.keys()];
    const sorted = [...tables].sort((left, right) => order.indexOf(left.name) - order.indexOf(right.name));
    let count = 0;
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL sync.disabled = 'on'`);
      await tx.$executeRawUnsafe(`TRUNCATE ${order.map(quote).join(', ')} CASCADE`);
      for (const table of sorted) {
        for (let at = 0; at < table.rows.length; at += CHUNK) {
          const rows = table.rows.slice(at, at + CHUNK);
          await tx.$executeRawUnsafe(`INSERT INTO ${quote(table.name)} SELECT * FROM jsonb_populate_recordset(NULL::${quote(table.name)}, $1::jsonb)`, JSON.stringify(rows));
          count += rows.length;
        }
      }
    }, { timeout: 300_000, maxWait: 30_000 });
    this.lastReceivedAt = new Date();
    this.logger.log(`Replaced server data with a full copy from the laptop: ${count} rows.`);
    return { ok: true, rows: count };
  }

  /** Applies changes in the order they happened on the laptop. Re-sending a change is harmless. */
  async changes(version: string, changes: PushedChange[]) {
    await this.checkVersion(version);
    const known = await this.known();
    for (const change of changes) if (!known.has(change.table) || (change.op !== 'U' && change.op !== 'D')) throw new BadRequestException(`Unknown change for table ${change.table}`);
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL sync.disabled = 'on'`);
      for (const change of changes) {
        const table = known.get(change.table)!;
        await tx.$executeRawUnsafe(change.op === 'D' ? deleteSql(table) : upsertSql(table), JSON.stringify(change.row));
      }
    }, { timeout: 120_000, maxWait: 30_000 });
    this.lastReceivedAt = new Date();
    return { ok: true, applied: changes.map((change) => change.id) };
  }
}

function upsertSql(table: TableInfo) {
  const name = quote(table.name);
  const keys = table.primaryKey.map(quote).join(', ');
  const rest = table.columns.filter((column) => !table.primaryKey.includes(column));
  const action = rest.length ? `DO UPDATE SET ${rest.map((column) => `${quote(column)} = EXCLUDED.${quote(column)}`).join(', ')}` : 'DO NOTHING';
  return `INSERT INTO ${name} SELECT * FROM jsonb_populate_record(NULL::${name}, $1::jsonb) ON CONFLICT (${keys}) ${action}`;
}

function deleteSql(table: TableInfo) {
  const name = quote(table.name);
  const keys = table.primaryKey.map(quote).join(', ');
  return `DELETE FROM ${name} WHERE (${keys}) = (SELECT ${keys} FROM jsonb_populate_record(NULL::${name}, $1::jsonb))`;
}
