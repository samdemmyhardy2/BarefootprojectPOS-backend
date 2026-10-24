CREATE TYPE "OrderType" AS ENUM ('DINE_IN', 'ROOM_SERVICE', 'PICKUP');

ALTER TABLE "Order"
ADD COLUMN "type" "OrderType" NOT NULL DEFAULT 'DINE_IN',
ADD COLUMN "customerName" TEXT,
ADD COLUMN "customerPhone" TEXT;

UPDATE "Order"
SET "type" = 'ROOM_SERVICE'
WHERE "roomStayId" IS NOT NULL AND "tableId" IS NULL;

CREATE INDEX "Order_type_status_createdAt_idx"
ON "Order"("type", "status", "createdAt");
