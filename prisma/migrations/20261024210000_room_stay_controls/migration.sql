ALTER TABLE "RoomStay"
  ADD COLUMN "expectedCheckoutAt" TIMESTAMP(3),
  ADD COLUMN "guestNotes" TEXT,
  ADD COLUMN "cashOnly" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "chargeLimit" DECIMAL(10,2);
