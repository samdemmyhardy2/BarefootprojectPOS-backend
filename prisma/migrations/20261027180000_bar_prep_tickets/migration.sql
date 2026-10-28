CREATE TYPE "PrepStation" AS ENUM ('KITCHEN', 'BAR');
CREATE TYPE "ModifierMadeAt" AS ENUM ('SAME_AS_DISH', 'KITCHEN', 'BAR');
CREATE TYPE "PrepTicketStatus" AS ENUM ('PENDING', 'PREPARING', 'READY');

ALTER TABLE "MenuItem"
ADD COLUMN "prepStation" "PrepStation" NOT NULL DEFAULT 'KITCHEN';

ALTER TABLE "ModifierGroup"
ADD COLUMN "madeAt" "ModifierMadeAt" NOT NULL DEFAULT 'SAME_AS_DISH';

CREATE TABLE "OrderPrepTicket" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "station" "PrepStation" NOT NULL,
    "status" "PrepTicketStatus" NOT NULL DEFAULT 'PENDING',
    "items" JSONB NOT NULL,
    "preparingAt" TIMESTAMP(3),
    "readyAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OrderPrepTicket_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrderPrepTicket_orderId_station_key" ON "OrderPrepTicket"("orderId", "station");
CREATE INDEX "OrderPrepTicket_station_status_createdAt_idx" ON "OrderPrepTicket"("station", "status", "createdAt");
ALTER TABLE "OrderPrepTicket" ADD CONSTRAINT "OrderPrepTicket_orderId_fkey"
FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
