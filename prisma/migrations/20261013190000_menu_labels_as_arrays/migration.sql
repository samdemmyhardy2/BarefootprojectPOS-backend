ALTER TABLE "MenuItem"
  ALTER COLUMN "allergens" TYPE TEXT[]
    USING CASE WHEN "allergens" IS NULL OR btrim("allergens") = '' THEN ARRAY[]::TEXT[] ELSE regexp_split_to_array("allergens", '\s*,\s*') END,
  ALTER COLUMN "allergens" SET DEFAULT ARRAY[]::TEXT[],
  ALTER COLUMN "allergens" SET NOT NULL,
  ALTER COLUMN "dietaryInfo" TYPE TEXT[]
    USING CASE WHEN "dietaryInfo" IS NULL OR btrim("dietaryInfo") = '' THEN ARRAY[]::TEXT[] ELSE regexp_split_to_array("dietaryInfo", '\s*,\s*') END,
  ALTER COLUMN "dietaryInfo" SET DEFAULT ARRAY[]::TEXT[],
  ALTER COLUMN "dietaryInfo" SET NOT NULL,
  ALTER COLUMN "availableExtras" TYPE TEXT[]
    USING CASE WHEN "availableExtras" IS NULL OR btrim("availableExtras") = '' THEN ARRAY[]::TEXT[] ELSE regexp_split_to_array("availableExtras", '\s*,\s*') END,
  ALTER COLUMN "availableExtras" SET DEFAULT ARRAY[]::TEXT[],
  ALTER COLUMN "availableExtras" SET NOT NULL;
