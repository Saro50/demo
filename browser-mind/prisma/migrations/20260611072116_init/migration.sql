-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL DEFAULT 'CREATED',
    "goal" TEXT,
    "url" TEXT,
    "summary" TEXT,
    "config" TEXT,
    "error" TEXT,
    "llmModel" TEXT,
    "totalSteps" INTEGER NOT NULL DEFAULT 0,
    "totalDuration" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ActionLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "stepNumber" INTEGER NOT NULL,
    "actionType" TEXT NOT NULL,
    "actionInput" TEXT NOT NULL,
    "actionOutput" TEXT,
    "success" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "llmIntent" TEXT,
    "observationBefore" TEXT,
    "observationAfter" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ActionLog_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Observation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "stepNumber" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT,
    "viewport" TEXT,
    "summary" TEXT,
    "pageStructure" TEXT,
    "hotSpots" TEXT,
    "networkState" TEXT,
    "consoleLogs" TEXT,
    "storageState" TEXT,
    "screenshotPath" TEXT,
    "pageSourceHash" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Observation_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProbeResult" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actionLogId" TEXT,
    "probeName" TEXT NOT NULL,
    "script" TEXT,
    "result" TEXT NOT NULL,
    "resultSize" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProbeResult_actionLogId_fkey" FOREIGN KEY ("actionLogId") REFERENCES "ActionLog" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Session_status_idx" ON "Session"("status");

-- CreateIndex
CREATE INDEX "Session_createdAt_idx" ON "Session"("createdAt");

-- CreateIndex
CREATE INDEX "ActionLog_sessionId_stepNumber_idx" ON "ActionLog"("sessionId", "stepNumber");

-- CreateIndex
CREATE INDEX "ActionLog_sessionId_actionType_idx" ON "ActionLog"("sessionId", "actionType");

-- CreateIndex
CREATE INDEX "ActionLog_createdAt_idx" ON "ActionLog"("createdAt");

-- CreateIndex
CREATE INDEX "Observation_sessionId_stepNumber_idx" ON "Observation"("sessionId", "stepNumber");

-- CreateIndex
CREATE INDEX "Observation_createdAt_idx" ON "Observation"("createdAt");
