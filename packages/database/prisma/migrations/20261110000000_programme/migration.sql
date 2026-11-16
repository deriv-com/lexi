-- Rebuild programme tables: programmes, milestones, build tasks, the design,
-- API-contract and parity-inventory snapshots, and run evidence.
--
-- Additive only, and idempotent: every statement is IF NOT EXISTS, so running
-- it twice is safe. Generated with `prisma migrate diff` from the schema before
-- these models to the schema after them, then made idempotent by hand.
--
-- Apply it yourself, before deploying code that uses these models. Nothing in
-- this repository applies migrations.

-- CreateTable
CREATE TABLE IF NOT EXISTS "app_rebuild_programmes" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "targetRepoKey" TEXT NOT NULL,
    "platform" TEXT,
    "sourceSpecRepoKey" TEXT,
    "sourceSpecIssueNumber" INTEGER,
    "figmaFileKeys" JSONB NOT NULL DEFAULT '[]',
    "designContextId" TEXT,
    "specId" TEXT,
    "referenceRepoKey" TEXT,
    "pausedReason" TEXT,
    "createdBy" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_rebuild_programmes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "programme_milestones" (
    "id" TEXT NOT NULL,
    "programmeId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "specId" TEXT,
    "reviewChannel" TEXT,
    "reviewThreadTs" TEXT,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "sweepAttemptId" TEXT,
    "sweepHeadSha" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "programme_milestones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "build_tasks" (
    "id" TEXT NOT NULL,
    "programmeId" TEXT NOT NULL,
    "milestoneId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "dependsOn" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "codeRepoKey" TEXT NOT NULL,
    "acceptanceCriterionIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "designContextNodeIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "currentAttemptId" TEXT,
    "prNumber" INTEGER,
    "mergedSha" TEXT,
    "lastMergeVerdict" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "build_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "design_context_documents" (
    "id" TEXT NOT NULL,
    "figmaFileKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "content" JSONB NOT NULL,
    "componentCatalogue" JSONB,

    CONSTRAINT "design_context_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "api_contract_documents" (
    "id" TEXT NOT NULL,
    "sourceRepoSlug" TEXT NOT NULL,
    "sourcePath" TEXT NOT NULL,
    "sourceSha" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "info" JSONB NOT NULL,
    "operations" JSONB NOT NULL,
    "excludedOperationCount" INTEGER NOT NULL DEFAULT 0,
    "spec" JSONB NOT NULL,

    CONSTRAINT "api_contract_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "parity_inventory_documents" (
    "id" TEXT NOT NULL,
    "referenceRepoSlug" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "headSha" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "platform" TEXT NOT NULL,
    "content" JSONB NOT NULL,

    CONSTRAINT "parity_inventory_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "run_evidence_records" (
    "id" TEXT NOT NULL,
    "bundleKey" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "workflowRunId" TEXT,
    "commitSha" TEXT,
    "checks" JSONB NOT NULL DEFAULT '[]',
    "failingTests" JSONB NOT NULL DEFAULT '[]',
    "artifacts" JSONB NOT NULL DEFAULT '[]',
    "reportedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_evidence_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "app_rebuild_programmes_key_key" ON "app_rebuild_programmes"("key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "app_rebuild_programmes_status_idx" ON "app_rebuild_programmes"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "programme_milestones_programmeId_ordinal_idx" ON "programme_milestones"("programmeId", "ordinal");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "programme_milestones_programmeId_status_idx" ON "programme_milestones"("programmeId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "build_tasks_programmeId_status_idx" ON "build_tasks"("programmeId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "build_tasks_milestoneId_status_idx" ON "build_tasks"("milestoneId", "status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "design_context_documents_figmaFileKey_version_key" ON "design_context_documents"("figmaFileKey", "version");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "api_contract_documents_sourceRepoSlug_sourcePath_version_key" ON "api_contract_documents"("sourceRepoSlug", "sourcePath", "version");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "parity_inventory_documents_referenceRepoSlug_version_key" ON "parity_inventory_documents"("referenceRepoSlug", "version");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "run_evidence_records_bundleKey_key" ON "run_evidence_records"("bundleKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "run_evidence_records_attemptId_receivedAt_idx" ON "run_evidence_records"("attemptId", "receivedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "run_evidence_records_attemptId_phase_idx" ON "run_evidence_records"("attemptId", "phase");

