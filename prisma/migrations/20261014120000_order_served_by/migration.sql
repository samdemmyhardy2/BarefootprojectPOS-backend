ALTER TABLE "Order" ADD COLUMN "servedById" TEXT;

CREATE INDEX "Order_servedById_idx" ON "Order"("servedById");

ALTER TABLE "Order"
ADD CONSTRAINT "Order_servedById_fkey"
FOREIGN KEY ("servedById") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
