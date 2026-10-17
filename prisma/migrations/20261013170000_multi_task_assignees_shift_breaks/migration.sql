CREATE TABLE "TaskAssignment" (
    "taskId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TaskAssignment_pkey" PRIMARY KEY ("taskId", "employeeId"),
    CONSTRAINT "TaskAssignment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TaskAssignment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "TaskAssignment" ("taskId", "employeeId")
SELECT "id", "assignedToId" FROM "Task";

DROP INDEX "Task_assignedToId_status_dueAt_idx";
ALTER TABLE "Task" DROP CONSTRAINT "Task_assignedToId_fkey";
ALTER TABLE "Task" DROP COLUMN "assignedToId";
CREATE INDEX "Task_status_dueAt_idx" ON "Task"("status", "dueAt");
CREATE INDEX "TaskAssignment_employeeId_idx" ON "TaskAssignment"("employeeId");

CREATE TABLE "ShiftBreak" (
    "id" TEXT NOT NULL,
    "employeeShiftId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShiftBreak_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ShiftBreak_employeeShiftId_fkey" FOREIGN KEY ("employeeShiftId") REFERENCES "EmployeeShift"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ShiftBreak_employeeShiftId_endedAt_idx" ON "ShiftBreak"("employeeShiftId", "endedAt");
CREATE UNIQUE INDEX "ShiftBreak_one_open_per_shift_idx" ON "ShiftBreak"("employeeShiftId") WHERE "endedAt" IS NULL;
