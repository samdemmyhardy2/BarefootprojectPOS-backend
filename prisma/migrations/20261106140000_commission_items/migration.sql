CREATE TABLE "CommissionItem" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "commission" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommissionItem_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "RoomCharge" ADD COLUMN "commissionItemId" TEXT;
ALTER TABLE "RoomCharge" ADD COLUMN "commissionAmount" DECIMAL(10,2);
ALTER TABLE "RoomCharge" ADD CONSTRAINT "RoomCharge_commissionItemId_fkey" FOREIGN KEY ("commissionItemId") REFERENCES "CommissionItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "CommissionItem" ("id", "name", "price", "commission")
VALUES ('commission-speed-boat', 'Speed boat', 350.00, 50.00);
