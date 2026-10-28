CREATE TYPE "ModifierSelectionType" AS ENUM ('SINGLE', 'MULTIPLE');

CREATE TABLE "ModifierGroup" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "nameMy" TEXT NOT NULL DEFAULT '',
  "nameTh" TEXT NOT NULL DEFAULT '',
  "category" TEXT NOT NULL DEFAULT 'General',
  "required" BOOLEAN NOT NULL DEFAULT false,
  "selectionType" "ModifierSelectionType" NOT NULL DEFAULT 'MULTIPLE',
  "minPicks" INTEGER NOT NULL DEFAULT 0,
  "maxPicks" INTEGER NOT NULL DEFAULT 1,
  "includedPicks" INTEGER NOT NULL DEFAULT 0,
  "allowDuplicates" BOOLEAN NOT NULL DEFAULT false,
  "position" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ModifierGroup_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ModifierGroup_pick_limits_check" CHECK ("minPicks" <= "maxPicks" AND "includedPicks" <= "maxPicks")
);

CREATE TABLE "ModifierOption" (
  "id" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "nameMy" TEXT NOT NULL DEFAULT '',
  "nameTh" TEXT NOT NULL DEFAULT '',
  "priceAdjustment" DECIMAL(10,2) NOT NULL DEFAULT 0,
  "defaultSelected" BOOLEAN NOT NULL DEFAULT false,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "position" INTEGER NOT NULL DEFAULT 0,
  "opensGroupId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ModifierOption_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MenuItemModifierGroup" (
  "menuItemId" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "MenuItemModifierGroup_pkey" PRIMARY KEY ("menuItemId", "groupId")
);

ALTER TABLE "OrderItem" ADD COLUMN "modifierSelections" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "MenuItem" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "MenuItem_categoryId_position_idx" ON "MenuItem"("categoryId", "position");
CREATE INDEX "ModifierGroup_category_position_idx" ON "ModifierGroup"("category", "position");
CREATE INDEX "ModifierOption_groupId_position_idx" ON "ModifierOption"("groupId", "position");
CREATE INDEX "MenuItemModifierGroup_groupId_position_idx" ON "MenuItemModifierGroup"("groupId", "position");
ALTER TABLE "ModifierOption" ADD CONSTRAINT "ModifierOption_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ModifierGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ModifierOption" ADD CONSTRAINT "ModifierOption_opensGroupId_fkey" FOREIGN KEY ("opensGroupId") REFERENCES "ModifierGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MenuItemModifierGroup" ADD CONSTRAINT "MenuItemModifierGroup_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MenuItemModifierGroup" ADD CONSTRAINT "MenuItemModifierGroup_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ModifierGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
