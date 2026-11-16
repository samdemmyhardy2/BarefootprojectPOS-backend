ALTER TYPE "PrepStation" ADD VALUE IF NOT EXISTS 'NONE';

ALTER TABLE "Order" ADD COLUMN "number" INTEGER;
ALTER TABLE "Order" ADD COLUMN "tableSnapshot" JSONB;

WITH numbered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY "createdAt", id) AS n FROM "Order"
)
UPDATE "Order" AS o SET "number" = numbered.n FROM numbered WHERE o.id = numbered.id;

ALTER TABLE "Order" ALTER COLUMN "number" SET NOT NULL;
CREATE UNIQUE INDEX "Order_number_key" ON "Order"("number");

ALTER TABLE "Order" DROP CONSTRAINT IF EXISTS "Order_tableId_fkey";
ALTER TABLE "Order" ADD CONSTRAINT "Order_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "Table"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "OrderItem" ADD COLUMN "itemSnapshot" JSONB;
ALTER TABLE "OrderItem" ALTER COLUMN "menuItemId" DROP NOT NULL;
ALTER TABLE "OrderItem" DROP CONSTRAINT IF EXISTS "OrderItem_menuItemId_fkey";
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "OrderPrepTicket" DROP CONSTRAINT IF EXISTS "OrderPrepTicket_orderId_station_key";
CREATE INDEX IF NOT EXISTS "OrderPrepTicket_orderId_station_idx" ON "OrderPrepTicket"("orderId", "station");

ALTER TABLE "RoomCharge" ADD COLUMN "billId" TEXT;
ALTER TABLE "RoomCharge" ADD COLUMN "billNumber" INTEGER;
ALTER TABLE "RoomCharge" ADD COLUMN "lines" JSONB;

CREATE TABLE "TableBill" (
  "id" TEXT NOT NULL,
  "tableId" TEXT NOT NULL,
  "number" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "method" TEXT,
  "stayId" TEXT,
  "amount" DECIMAL(10,2) NOT NULL,
  "signedByName" TEXT,
  "signatureData" TEXT,
  "paidAt" TIMESTAMP(3),
  "chargeId" TEXT,
  "lines" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TableBill_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TableBill_tableId_status_idx" ON "TableBill"("tableId", "status");
ALTER TABLE "TableBill" ADD CONSTRAINT "TableBill_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "Table"("id") ON DELETE CASCADE ON UPDATE CASCADE;
