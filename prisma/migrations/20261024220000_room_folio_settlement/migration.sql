ALTER TYPE "OrderPaymentMethod" ADD VALUE 'CARD';
CREATE TYPE "RoomPaymentMethod" AS ENUM ('CASH', 'CARD');

ALTER TABLE "RoomCharge" ADD COLUMN "settledAt" TIMESTAMP(3);

CREATE TABLE "RoomPayment" (
  "id" TEXT NOT NULL,
  "stayId" TEXT NOT NULL,
  "amount" DECIMAL(10,2) NOT NULL,
  "method" "RoomPaymentMethod" NOT NULL,
  "note" TEXT,
  "receivedById" TEXT,
  "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RoomPayment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RoomPayment_stayId_paidAt_idx" ON "RoomPayment"("stayId", "paidAt");
ALTER TABLE "RoomPayment" ADD CONSTRAINT "RoomPayment_stayId_fkey" FOREIGN KEY ("stayId") REFERENCES "RoomStay"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RoomPayment" ADD CONSTRAINT "RoomPayment_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
