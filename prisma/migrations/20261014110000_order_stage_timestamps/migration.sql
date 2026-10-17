ALTER TABLE "Order"
  ADD COLUMN "preparingAt" TIMESTAMP(3),
  ADD COLUMN "readyAt" TIMESTAMP(3),
  ADD COLUMN "servedAt" TIMESTAMP(3);

-- Backfill the best available historical timestamps where the old schema
-- only kept createdAt and updatedAt.
UPDATE "Order"
SET "readyAt" = "updatedAt"
WHERE "status" IN ('READY', 'SERVED', 'COMPLETED') AND "readyAt" IS NULL;

UPDATE "Order"
SET "servedAt" = "updatedAt"
WHERE "status" IN ('SERVED', 'COMPLETED') AND "servedAt" IS NULL;
