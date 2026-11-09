-- CreateEnum
CREATE TYPE "PostPlatform" AS ENUM ('INSTAGRAM', 'FACEBOOK', 'THREADS');

-- AlterTable
ALTER TABLE "InstagramAccount" ADD COLUMN     "facebookConnectedAt" TIMESTAMP(3),
ADD COLUMN     "facebookIgUserId" TEXT,
ADD COLUMN     "facebookPageId" TEXT,
ADD COLUMN     "facebookPageName" TEXT,
ADD COLUMN     "facebookPageToken" TEXT,
ADD COLUMN     "facebookUserExpiresAt" TIMESTAMP(3),
ADD COLUMN     "facebookUserToken" TEXT;

-- AlterTable
ALTER TABLE "ScheduledPost" ADD COLUMN     "audioId" TEXT,
ADD COLUMN     "audioTitle" TEXT,
ADD COLUMN     "audioVolume" INTEGER,
ADD COLUMN     "groupId" TEXT,
ADD COLUMN     "platform" "PostPlatform" NOT NULL DEFAULT 'INSTAGRAM',
ADD COLUMN     "threadsAccountId" TEXT,
ADD COLUMN     "videoVolume" INTEGER,
ALTER COLUMN "instagramAccountId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "ThreadsAccount" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "threadsUserId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "tokenExpiresAt" TIMESTAMP(3),
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ThreadsAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ThreadsAccount_threadsUserId_key" ON "ThreadsAccount"("threadsUserId");

-- CreateIndex
CREATE INDEX "ThreadsAccount_workspaceId_idx" ON "ThreadsAccount"("workspaceId");

-- CreateIndex
CREATE INDEX "ScheduledPost_groupId_idx" ON "ScheduledPost"("groupId");

-- AddForeignKey
ALTER TABLE "ScheduledPost" ADD CONSTRAINT "ScheduledPost_threadsAccountId_fkey" FOREIGN KEY ("threadsAccountId") REFERENCES "ThreadsAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThreadsAccount" ADD CONSTRAINT "ThreadsAccount_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
