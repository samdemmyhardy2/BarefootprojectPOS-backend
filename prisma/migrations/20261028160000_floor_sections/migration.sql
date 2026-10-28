CREATE TABLE "FloorSection" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FloorSection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FloorSection_position_key" ON "FloorSection"("position");

INSERT INTO "FloorSection" ("id", "name", "position", "createdAt", "updatedAt")
VALUES ('00000000-0000-4000-8000-000000000001', 'Main floor', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

ALTER TABLE "Table" ADD COLUMN "sectionId" TEXT;

UPDATE "Table" SET "sectionId" = '00000000-0000-4000-8000-000000000001' WHERE "sectionId" IS NULL;

ALTER TABLE "Table" ALTER COLUMN "sectionId" SET NOT NULL;

ALTER TABLE "Table" ADD CONSTRAINT "Table_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "FloorSection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "Table_sectionId_idx" ON "Table"("sectionId");
