CREATE TABLE "ClientSubmission" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientSubmission_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ClientSubmission_scope_key_key" ON "ClientSubmission"("scope", "key");
