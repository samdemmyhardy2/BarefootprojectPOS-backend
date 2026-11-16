CREATE TABLE "EmailSyncRun" (
  "id" TEXT NOT NULL,
  "trigger" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  "imapConnected" BOOLEAN NOT NULL DEFAULT false,
  "scanned" INTEGER NOT NULL DEFAULT 0,
  "discovered" INTEGER NOT NULL DEFAULT 0,
  "nested" INTEGER NOT NULL DEFAULT 0,
  "duplicates" INTEGER NOT NULL DEFAULT 0,
  "confirmed" INTEGER NOT NULL DEFAULT 0,
  "modified" INTEGER NOT NULL DEFAULT 0,
  "cancelled" INTEGER NOT NULL DEFAULT 0,
  "payments" INTEGER NOT NULL DEFAULT 0,
  "imported" INTEGER NOT NULL DEFAULT 0,
  "updated" INTEGER NOT NULL DEFAULT 0,
  "canceled" INTEGER NOT NULL DEFAULT 0,
  "skipped" INTEGER NOT NULL DEFAULT 0,
  "unmatched" INTEGER NOT NULL DEFAULT 0,
  "failed" INTEGER NOT NULL DEFAULT 0,
  "parts" INTEGER NOT NULL DEFAULT 0,
  "attachments" INTEGER NOT NULL DEFAULT 0,
  "maxDepth" INTEGER NOT NULL DEFAULT 0,
  "uniqueEmails" INTEGER NOT NULL DEFAULT 0,
  "processedAttachments" INTEGER NOT NULL DEFAULT 0,
  "failedAttachments" INTEGER NOT NULL DEFAULT 0,
  "unprocessedAttachments" INTEGER NOT NULL DEFAULT 0,
  "lastUid" INTEGER,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmailSyncRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EmailSyncRun_startedAt_idx" ON "EmailSyncRun"("startedAt");

ALTER TABLE "InboundEmail"
  ADD COLUMN "guestName" TEXT,
  ADD COLUMN "cloudbedsReservationId" TEXT,
  ADD COLUMN "parentMessageId" TEXT,
  ADD COLUMN "nestingDepth" INTEGER,
  ADD COLUMN "attemptLog" JSONB,
  ADD COLUMN "syncRunId" TEXT;

CREATE INDEX "InboundEmail_confirmationNumber_idx" ON "InboundEmail"("confirmationNumber");
CREATE INDEX "InboundEmail_cloudbedsReservationId_idx" ON "InboundEmail"("cloudbedsReservationId");
CREATE INDEX "InboundEmail_syncRunId_idx" ON "InboundEmail"("syncRunId");

ALTER TABLE "InboundEmail"
  ADD CONSTRAINT "InboundEmail_syncRunId_fkey"
  FOREIGN KEY ("syncRunId") REFERENCES "EmailSyncRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
