CREATE TYPE "OrderPaymentStatus" AS ENUM ('UNPAID', 'PAID', 'ROOM_FOLIO');

ALTER TABLE "Order"
  ADD COLUMN "paymentStatus" "OrderPaymentStatus" NOT NULL DEFAULT 'UNPAID',
  ADD COLUMN "paidAt" TIMESTAMP(3),
  ADD COLUMN "paidById" TEXT;

CREATE INDEX "Order_paidById_idx" ON "Order"("paidById");

ALTER TABLE "Order"
ADD CONSTRAINT "Order_paidById_fkey"
FOREIGN KEY ("paidById") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

UPDATE "Order" o
SET "paymentStatus" = 'ROOM_FOLIO'
WHERE EXISTS (SELECT 1 FROM "RoomCharge" rc WHERE rc."orderId" = o."id");
