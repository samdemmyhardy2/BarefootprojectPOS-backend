ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'READY';

CREATE TABLE "EmployeeShift" (
  "id" TEXT NOT NULL,
  "employeeId" TEXT NOT NULL,
  "checkedInAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "checkedOutAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmployeeShift_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EmployeeShift_employeeId_checkedInAt_idx" ON "EmployeeShift"("employeeId", "checkedInAt");
CREATE UNIQUE INDEX "EmployeeShift_one_open_shift_per_employee_idx" ON "EmployeeShift"("employeeId") WHERE "checkedOutAt" IS NULL;
ALTER TABLE "EmployeeShift" ADD CONSTRAINT "EmployeeShift_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
