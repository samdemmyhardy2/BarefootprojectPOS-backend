import { PrismaService } from '../../utils/prisma/prisma.service';

/** Tables that are never copied: Prisma's own history and the sync bookkeeping. */
const SKIPPED = new Set(['_prisma_migrations', 'SyncChange', 'SyncState']);

export type TableInfo = { name: string; primaryKey: string[]; columns: string[] };

export const quote = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

type Runner = Pick<PrismaService, '$queryRawUnsafe'>;

/** Application tables in an order where every table comes after the tables it references, so inserts never break a foreign key. */
export async function syncTables(db: Runner): Promise<TableInfo[]> {
  const [tables, columns, keys, links] = await Promise.all([
    db.$queryRawUnsafe<{ name: string }[]>(`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema() AND c.relkind = 'r' ORDER BY 1`),
    db.$queryRawUnsafe<{ table: string; column: string }[]>(`SELECT table_name AS "table", column_name AS "column" FROM information_schema.columns WHERE table_schema = current_schema() ORDER BY table_name, ordinal_position`),
    db.$queryRawUnsafe<{ table: string; column: string }[]>(`SELECT c.relname AS "table", a.attname AS "column" FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indisprimary AND n.nspname = current_schema() ORDER BY c.relname, array_position(i.indkey, a.attnum)`),
    db.$queryRawUnsafe<{ child: string; parent: string }[]>(`SELECT c.relname AS child, p.relname AS parent FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_class p ON p.oid = k.confrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE k.contype = 'f' AND n.nspname = current_schema()`),
  ]);
  const names = tables.map((table) => table.name).filter((name) => !SKIPPED.has(name));
  const info = new Map(names.map((name) => [name, {
    name,
    primaryKey: keys.filter((key) => key.table === name).map((key) => key.column),
    columns: columns.filter((column) => column.table === name).map((column) => column.column),
  }]));
  const parents = new Map(names.map((name) => [name, new Set(links.filter((link) => link.child === name && link.parent !== name && info.has(link.parent)).map((link) => link.parent))]));
  const ordered: TableInfo[] = [];
  const placed = new Set<string>();
  while (ordered.length < names.length) {
    const ready = names.filter((name) => !placed.has(name) && [...parents.get(name)!].every((parent) => placed.has(parent)));
    // A reference cycle would stall the sort; place the rest by name rather than loop forever.
    const next = ready.length ? ready : names.filter((name) => !placed.has(name));
    for (const name of next) { placed.add(name); ordered.push(info.get(name)!); }
  }
  return ordered;
}

/** Name of the newest applied migration. Both databases must match before rows are copied. */
export async function schemaVersion(db: Runner) {
  const rows = await db.$queryRawUnsafe<{ name: string | null }[]>(`SELECT max(migration_name) AS name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`);
  return rows[0]?.name ?? '';
}

export type SyncRole = 'client' | 'server' | 'off';

/** SYNC_ROLE=server on the hosted copy; the restaurant laptop is the client when SYNC_SERVER_URL is set. */
export function syncRole(): SyncRole {
  if (process.env.SYNC_ROLE?.trim().toLowerCase() === 'server') return 'server';
  return process.env.SYNC_SERVER_URL?.trim() && process.env.SYNC_TOKEN?.trim() ? 'client' : 'off';
}
