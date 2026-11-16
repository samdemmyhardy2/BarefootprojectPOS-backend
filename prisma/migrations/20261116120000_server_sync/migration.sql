-- CreateTable
CREATE TABLE "SyncChange" (
    "id" BIGSERIAL NOT NULL,
    "table" TEXT NOT NULL,
    "op" TEXT NOT NULL,
    "row" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncState" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncState_pkey" PRIMARY KEY ("key")
);

-- Records each row change for the hosted server. 'U' carries the new row (insert or update), 'D' the deleted row.
-- The server sets sync.disabled while applying pushed changes, so they are not recorded again there.
CREATE OR REPLACE FUNCTION sync_capture() RETURNS trigger AS $$
BEGIN
  IF coalesce(current_setting('sync.disabled', true), '') = 'on' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    INSERT INTO "SyncChange" ("table", "op", "row") VALUES (TG_TABLE_NAME, 'D', to_jsonb(OLD));
  ELSE
    INSERT INTO "SyncChange" ("table", "op", "row") VALUES (TG_TABLE_NAME, 'U', to_jsonb(NEW));
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Adds the trigger to every application table. The server sync service calls it again at startup, so tables added by
-- later migrations are covered too.
CREATE OR REPLACE FUNCTION sync_install_triggers() RETURNS void AS $$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relkind = 'r'
      AND c.relname NOT IN ('_prisma_migrations', 'SyncChange', 'SyncState')
      AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'sync_capture')
  LOOP
    EXECUTE format('CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION sync_capture()', target.relname);
  END LOOP;
END;
$$ LANGUAGE plpgsql;

SELECT sync_install_triggers();
