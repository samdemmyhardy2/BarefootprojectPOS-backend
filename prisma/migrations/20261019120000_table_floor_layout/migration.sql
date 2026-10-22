CREATE TYPE "TableShape" AS ENUM ('ROUND', 'SQUARE', 'RECTANGLE', 'OVAL', 'BOOTH', 'BAR');

ALTER TABLE "Table"
  ADD COLUMN "shape" "TableShape" NOT NULL DEFAULT 'RECTANGLE',
  ADD COLUMN "positionX" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "positionY" INTEGER NOT NULL DEFAULT 0;

WITH numbered AS (
  SELECT "id", "capacity", ROW_NUMBER() OVER (ORDER BY "tableNumber") - 1 AS slot
  FROM "Table"
)
UPDATE "Table" AS target
SET "positionX" = ((numbered.slot % 4) * 2)::INTEGER,
    "positionY" = (FLOOR(numbered.slot / 4.0) * 2)::INTEGER,
    "shape" = CASE
      WHEN numbered."capacity" <= 2 THEN 'ROUND'::"TableShape"
      WHEN numbered."capacity" >= 8 THEN 'OVAL'::"TableShape"
      ELSE 'RECTANGLE'::"TableShape"
    END
FROM numbered
WHERE target."id" = numbered."id";
