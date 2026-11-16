ALTER TABLE "RoomStay" ALTER COLUMN "roomId" DROP NOT NULL;
ALTER TABLE "RoomStay" ADD COLUMN "guestEmail" TEXT;
ALTER TABLE "RoomStay" ADD COLUMN "bookingSource" TEXT;
ALTER TABLE "RoomStay" ADD COLUMN "confirmationNumber" TEXT;
ALTER TABLE "RoomStay" ADD COLUMN "roomType" TEXT;
ALTER TABLE "RoomStay" ADD COLUMN "adults" INTEGER;
ALTER TABLE "RoomStay" ADD COLUMN "children" INTEGER;
ALTER TABLE "RoomStay" ADD COLUMN "payment" JSONB;
ALTER TABLE "RoomStay" ADD COLUMN "cancelledAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "RoomStay_bookingSource_confirmationNumber_key" ON "RoomStay"("bookingSource", "confirmationNumber");

CREATE TYPE "InboundEmailStatus" AS ENUM ('PROCESSED', 'DUPLICATE', 'FAILED', 'SKIPPED');
CREATE TABLE "InboundEmail" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "mailbox" TEXT NOT NULL,
    "uid" INTEGER,
    "subject" TEXT,
    "fromAddress" TEXT,
    "receivedAt" TIMESTAMP(3),
    "rawMime" TEXT NOT NULL,
    "status" "InboundEmailStatus" NOT NULL,
    "error" TEXT,
    "confirmationNumber" TEXT,
    "source" TEXT,
    "stayId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    CONSTRAINT "InboundEmail_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "InboundEmail_messageId_key" ON "InboundEmail"("messageId");
CREATE INDEX "InboundEmail_status_createdAt_idx" ON "InboundEmail"("status", "createdAt");
ALTER TABLE "InboundEmail" ADD CONSTRAINT "InboundEmail_stayId_fkey" FOREIGN KEY ("stayId") REFERENCES "RoomStay"("id") ON DELETE SET NULL ON UPDATE CASCADE;
