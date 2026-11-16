CREATE TABLE "TableSplit" (
    "id" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "roomStayId" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TableSplit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TableSplit_tableId_label_key" ON "TableSplit"("tableId", "label");
CREATE INDEX "TableSplit_tableId_idx" ON "TableSplit"("tableId");

ALTER TABLE "TableSplit" ADD CONSTRAINT "TableSplit_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "Table"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TableSplit" ADD CONSTRAINT "TableSplit_roomStayId_fkey" FOREIGN KEY ("roomStayId") REFERENCES "RoomStay"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Order" ADD COLUMN "tableSplitId" TEXT;
CREATE INDEX "Order_tableSplitId_idx" ON "Order"("tableSplitId");
ALTER TABLE "Order" ADD CONSTRAINT "Order_tableSplitId_fkey" FOREIGN KEY ("tableSplitId") REFERENCES "TableSplit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
