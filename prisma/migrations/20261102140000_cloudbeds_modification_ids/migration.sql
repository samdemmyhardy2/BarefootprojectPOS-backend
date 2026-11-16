ALTER TABLE "RoomStay" ADD COLUMN "cloudbedsReservationId" TEXT;
ALTER TABLE "InboundEmail" ADD COLUMN "noticeKind" TEXT;
ALTER TABLE "InboundEmail" ADD COLUMN "noticeAt" TIMESTAMP(3);
CREATE INDEX "RoomStay_sourceReservationId_idx" ON "RoomStay"("sourceReservationId");
CREATE INDEX "RoomStay_cloudbedsReservationId_idx" ON "RoomStay"("cloudbedsReservationId");
