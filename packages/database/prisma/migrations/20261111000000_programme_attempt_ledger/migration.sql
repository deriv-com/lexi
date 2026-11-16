-- Rebuild programme columns on the attempt ledger: which build task an attempt
-- served, the model it ran, its terminal outcome and its token spend.
--
-- Additive only, and idempotent: every statement is IF NOT EXISTS, so running
-- it twice is safe. Generated with `prisma migrate diff`, then made idempotent
-- by hand.
--
-- Apply it yourself BEFORE deploying code built from this schema: the Prisma
-- client selects every mapped column, so once it knows these columns every
-- read of quick_fix_attempts fails until they exist. Nothing in this
-- repository applies migrations.

-- AlterTable
ALTER TABLE "quick_fix_attempts" ADD COLUMN IF NOT EXISTS "buildTaskId" TEXT;
ALTER TABLE "quick_fix_attempts" ADD COLUMN IF NOT EXISTS "taskKind" TEXT;
ALTER TABLE "quick_fix_attempts" ADD COLUMN IF NOT EXISTS "attemptNumber" INTEGER;
ALTER TABLE "quick_fix_attempts" ADD COLUMN IF NOT EXISTS "model" TEXT;
ALTER TABLE "quick_fix_attempts" ADD COLUMN IF NOT EXISTS "outcome" TEXT;
ALTER TABLE "quick_fix_attempts" ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP(3);
ALTER TABLE "quick_fix_attempts" ADD COLUMN IF NOT EXISTS "inputTokens" INTEGER;
ALTER TABLE "quick_fix_attempts" ADD COLUMN IF NOT EXISTS "cachedInputTokens" INTEGER;
ALTER TABLE "quick_fix_attempts" ADD COLUMN IF NOT EXISTS "cacheCreationInputTokens" INTEGER;
ALTER TABLE "quick_fix_attempts" ADD COLUMN IF NOT EXISTS "outputTokens" INTEGER;
ALTER TABLE "quick_fix_attempts" ADD COLUMN IF NOT EXISTS "estimatedCostUsd" DOUBLE PRECISION;
ALTER TABLE "quick_fix_attempts" ADD COLUMN IF NOT EXISTS "reportedCostUsd" DOUBLE PRECISION;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "quick_fix_attempts_buildTaskId_idx" ON "quick_fix_attempts"("buildTaskId");
