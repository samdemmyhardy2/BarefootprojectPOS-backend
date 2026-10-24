CREATE TABLE "_TableRoomAssignments" (
  "A" TEXT NOT NULL,
  "B" TEXT NOT NULL
);

CREATE UNIQUE INDEX "_TableRoomAssignments_AB_unique" ON "_TableRoomAssignments"("A", "B");
CREATE INDEX "_TableRoomAssignments_B_index" ON "_TableRoomAssignments"("B");

ALTER TABLE "_TableRoomAssignments"
ADD CONSTRAINT "_TableRoomAssignments_A_fkey"
FOREIGN KEY ("A") REFERENCES "RoomStay"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "_TableRoomAssignments"
ADD CONSTRAINT "_TableRoomAssignments_B_fkey"
FOREIGN KEY ("B") REFERENCES "Table"("id") ON DELETE CASCADE ON UPDATE CASCADE;
