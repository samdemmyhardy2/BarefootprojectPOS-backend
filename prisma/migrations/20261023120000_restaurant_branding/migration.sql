CREATE TABLE "RestaurantSetting" (
    "id" TEXT NOT NULL DEFAULT 'restaurant',
    "name" TEXT NOT NULL DEFAULT 'Table & Thyme',
    "logoUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RestaurantSetting_pkey" PRIMARY KEY ("id")
);

INSERT INTO "RestaurantSetting" ("id", "name", "updatedAt")
VALUES ('restaurant', 'Table & Thyme', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
