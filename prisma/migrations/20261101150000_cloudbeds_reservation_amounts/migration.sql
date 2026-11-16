ALTER TABLE "RoomStay" ADD COLUMN "sourceReservationId" TEXT;
ALTER TABLE "RoomStay" ADD COLUMN "nights" INTEGER;
ALTER TABLE "RoomStay" ADD COLUMN "currency" TEXT;
ALTER TABLE "RoomStay" ADD COLUMN "averageNightlyRate" DECIMAL(12,2);
ALTER TABLE "RoomStay" ADD COLUMN "grandTotal" DECIMAL(12,2);
ALTER TABLE "RoomStay" ADD COLUMN "depositAmount" DECIMAL(12,2);
ALTER TABLE "RoomStay" ADD COLUMN "amountPaid" DECIMAL(12,2);
ALTER TABLE "RoomStay" ADD COLUMN "balanceDue" DECIMAL(12,2);

CREATE TABLE "ReservationNight" (
    "id" TEXT NOT NULL,
    "stayId" TEXT NOT NULL,
    "night" DATE NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL,
    CONSTRAINT "ReservationNight_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ReservationNight_stayId_night_idx" ON "ReservationNight"("stayId", "night");
ALTER TABLE "ReservationNight" ADD CONSTRAINT "ReservationNight_stayId_fkey" FOREIGN KEY ("stayId") REFERENCES "RoomStay"("id") ON DELETE CASCADE ON UPDATE CASCADE;
