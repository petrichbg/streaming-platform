CREATE TABLE "DevicePairing" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "secretHash" TEXT NOT NULL,
  "userId" TEXT,
  "deviceName" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "claimedAt" TIMESTAMP(3),
  "consumedAt" TIMESTAMP(3),
  CONSTRAINT "DevicePairing_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DevicePairing_code_key" ON "DevicePairing"("code");
CREATE INDEX "DevicePairing_expiresAt_consumedAt_idx" ON "DevicePairing"("expiresAt", "consumedAt");
