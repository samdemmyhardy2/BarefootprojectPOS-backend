ALTER TYPE "InboundEmailStatus" ADD VALUE IF NOT EXISTS 'PENDING';
ALTER TYPE "InboundEmailStatus" ADD VALUE IF NOT EXISTS 'PROCESSING';
ALTER TABLE "InboundEmail" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "InboundEmail" ADD COLUMN "nextAttemptAt" TIMESTAMP(3);
CREATE INDEX "InboundEmail_status_nextAttemptAt_idx" ON "InboundEmail"("status", "nextAttemptAt");
