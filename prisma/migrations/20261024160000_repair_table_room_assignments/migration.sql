-- Keep this migration safe when the relation exists on some environments but
-- was missed or partially created on others.
CREATE TABLE IF NOT EXISTS "_TableRoomAssignments" (
  "A" TEXT NOT NULL,
  "B" TEXT NOT NULL,
  CONSTRAINT "_TableRoomAssignments_AB_pkey" PRIMARY KEY ("A", "B")
);

CREATE INDEX IF NOT EXISTS "_TableRoomAssignments_B_index"
ON "_TableRoomAssignments"("B");

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = '_TableRoomAssignments_AB_pkey'
      AND conrelid = 'public."_TableRoomAssignments"'::regclass
  ) THEN
    DROP INDEX IF EXISTS "_TableRoomAssignments_AB_unique";
    ALTER TABLE "_TableRoomAssignments"
    ADD CONSTRAINT "_TableRoomAssignments_AB_pkey" PRIMARY KEY ("A", "B");
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = '_TableRoomAssignments_A_fkey'
      AND conrelid = 'public."_TableRoomAssignments"'::regclass
  ) THEN
    ALTER TABLE "_TableRoomAssignments"
    ADD CONSTRAINT "_TableRoomAssignments_A_fkey"
    FOREIGN KEY ("A") REFERENCES "RoomStay"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = '_TableRoomAssignments_B_fkey'
      AND conrelid = 'public."_TableRoomAssignments"'::regclass
  ) THEN
    ALTER TABLE "_TableRoomAssignments"
    ADD CONSTRAINT "_TableRoomAssignments_B_fkey"
    FOREIGN KEY ("B") REFERENCES "Table"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
