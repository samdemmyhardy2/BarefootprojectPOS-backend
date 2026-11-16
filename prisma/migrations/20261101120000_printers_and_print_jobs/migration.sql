CREATE TYPE "PrintJobStatus" AS ENUM ('PENDING', 'RENDERING', 'PRINTING', 'COMPLETED', 'FAILED');

CREATE TABLE "Printer" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "manufacturer" TEXT NOT NULL DEFAULT '',
  "model" TEXT NOT NULL DEFAULT '',
  "ipAddress" TEXT NOT NULL,
  "macAddress" TEXT NOT NULL DEFAULT '',
  "port" INTEGER NOT NULL DEFAULT 9100,
  "connectionType" TEXT NOT NULL DEFAULT 'RAW',
  "paperWidthMm" INTEGER NOT NULL DEFAULT 80,
  "resolutionDpi" INTEGER NOT NULL DEFAULT 203,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "purpose" TEXT NOT NULL DEFAULT 'RECEIPT',
  "lastSeenAt" TIMESTAMP(3),
  "lastCheckedAt" TIMESTAMP(3),
  "lastCheckOk" BOOLEAN,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Printer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PrintJob" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "printerId" TEXT NOT NULL,
  "requestedById" TEXT NOT NULL,
  "idempotencyKey" TEXT,
  "status" "PrintJobStatus" NOT NULL DEFAULT 'PENDING',
  "error" TEXT,
  "dryRun" BOOLEAN NOT NULL DEFAULT false,
  "retryCount" INTEGER NOT NULL DEFAULT 0,
  "renderedAt" TIMESTAMP(3),
  "sentAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PrintJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Printer_enabled_isDefault_idx" ON "Printer"("enabled", "isDefault");
CREATE UNIQUE INDEX "PrintJob_idempotencyKey_key" ON "PrintJob"("idempotencyKey");
CREATE INDEX "PrintJob_orderId_createdAt_idx" ON "PrintJob"("orderId", "createdAt");
CREATE INDEX "PrintJob_status_createdAt_idx" ON "PrintJob"("status", "createdAt");

ALTER TABLE "PrintJob" ADD CONSTRAINT "PrintJob_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PrintJob" ADD CONSTRAINT "PrintJob_printerId_fkey" FOREIGN KEY ("printerId") REFERENCES "Printer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
