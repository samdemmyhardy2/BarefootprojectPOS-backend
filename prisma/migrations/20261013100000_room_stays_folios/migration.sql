CREATE TYPE "RoomSize" AS ENUM ('NORMAL', 'FAMILY');
CREATE TYPE "RoomStatus" AS ENUM ('AVAILABLE', 'OCCUPIED');
CREATE TYPE "RoomChargeKind" AS ENUM ('ROOM_FEE', 'WATER', 'FOOD', 'RESTAURANT_ORDER', 'OTHER');
CREATE TYPE "OrderPaymentMethod" AS ENUM ('CASH', 'ROOM_CHECKOUT');

CREATE TABLE "Room" (
  "id" TEXT NOT NULL,
  "roomNumber" INTEGER NOT NULL,
  "size" "RoomSize" NOT NULL DEFAULT 'NORMAL',
  "usageFee" DECIMAL(10,2) NOT NULL DEFAULT 0,
  "status" "RoomStatus" NOT NULL DEFAULT 'AVAILABLE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Room_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Room_roomNumber_key" ON "Room"("roomNumber");

CREATE TABLE "RoomStay" (
  "id" TEXT NOT NULL,
  "roomId" TEXT NOT NULL,
  "primaryGuestName" TEXT NOT NULL,
  "checkedInAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "checkedOutAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RoomStay_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RoomStay_roomId_checkedOutAt_idx" ON "RoomStay"("roomId", "checkedOutAt");
ALTER TABLE "RoomStay" ADD CONSTRAINT "RoomStay_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "RoomOccupant" (
  "id" TEXT NOT NULL,
  "stayId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RoomOccupant_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "RoomOccupant" ADD CONSTRAINT "RoomOccupant_stayId_fkey" FOREIGN KEY ("stayId") REFERENCES "RoomStay"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "RoomCharge" (
  "id" TEXT NOT NULL,
  "stayId" TEXT NOT NULL,
  "orderId" TEXT,
  "kind" "RoomChargeKind" NOT NULL,
  "description" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "unitPrice" DECIMAL(10,2) NOT NULL,
  "amount" DECIMAL(10,2) NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RoomCharge_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RoomCharge_orderId_key" ON "RoomCharge"("orderId");
CREATE INDEX "RoomCharge_stayId_occurredAt_idx" ON "RoomCharge"("stayId", "occurredAt");
ALTER TABLE "RoomCharge" ADD CONSTRAINT "RoomCharge_stayId_fkey" FOREIGN KEY ("stayId") REFERENCES "RoomStay"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RoomCharge" ADD CONSTRAINT "RoomCharge_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Order" ALTER COLUMN "tableId" DROP NOT NULL;
ALTER TABLE "Order" ADD COLUMN "roomStayId" TEXT;
ALTER TABLE "Order" ADD COLUMN "paymentMethod" "OrderPaymentMethod" NOT NULL DEFAULT 'CASH';
CREATE INDEX "Order_roomStayId_idx" ON "Order"("roomStayId");
ALTER TABLE "Order" ADD CONSTRAINT "Order_roomStayId_fkey" FOREIGN KEY ("roomStayId") REFERENCES "RoomStay"("id") ON DELETE SET NULL ON UPDATE CASCADE;
