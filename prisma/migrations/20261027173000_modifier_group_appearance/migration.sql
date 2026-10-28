ALTER TABLE "ModifierGroup"
ADD COLUMN "appearance" TEXT NOT NULL DEFAULT 'CHECKBOX';

UPDATE "ModifierGroup"
SET "appearance" = CASE
  WHEN "selectionType" = 'SINGLE' THEN 'RADIO'
  WHEN "allowDuplicates" = TRUE THEN 'QUANTITY'
  ELSE 'CHECKBOX'
END;
