/**
 * Publish sweep: moves due ScheduledPosts through Meta's two-step Reels flow.
 *
 *   SCHEDULED --claim--> CREATING --container created--> PROCESSING
 *   PROCESSING --container FINISHED, claim--> PUBLISHING --published--> PUBLISHED
 *
 * The worker runs this once a minute, which is also Meta's recommended
 * container status polling cadence. Every transition is a guarded
 * updateMany on the current status, so two workers (or two overlapping
 * sweeps) never act on the same post, and nothing is held in Redis.
 *
 * Double-publish safety: a post only reaches media_publish from PROCESSING
 * after reading the container's status. A container that is already
 * PUBLISHED (a crash after publishing but before saving) is marked done
 * instead of published again.
 */

import type { ScheduledPost } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import {
  createReelContainer,
  getContainerStatus,
  getMediaPermalink,
  MetaApiError,
  PermissionError,
  publishContainer,
  RateLimitError,
  TokenExpiredError,
} from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";

const BATCH_SIZE = 10;
// A post left in a transient claim state this long belongs to a worker that died.
const STALE_CLAIM_MS = 10 * 60_000;
// Meta normally processes a Reel in minutes; give up well before the 24h container expiry.
const PROCESSING_TIMEOUT_MS = 60 * 60_000;
const MAX_ATTEMPTS = 5;
const RETRY_BACKOFF_MS = 5 * 60_000;

type PostWithAccount = ScheduledPost & {
  instagramAccount: { instagramId: string; accessToken: string };
};

export interface PublishSweepResult {
  started: number;
  checked: number;
}

export async function runPublishSweep(
  now: Date = new Date()
): Promise<PublishSweepResult> {
  await recoverStaleClaims(now);

  const due = await prisma.scheduledPost.findMany({
    where: { status: "SCHEDULED", publishAt: { lte: now } },
    orderBy: { publishAt: "asc" },
    take: BATCH_SIZE,
    select: { id: true },
  });
  for (const { id } of due) {
    await startPost(id, now);
  }

  const processing = await prisma.scheduledPost.findMany({
    where: { status: "PROCESSING" },
    orderBy: { updatedAt: "asc" },
    take: BATCH_SIZE,
    select: { id: true },
  });
  for (const { id } of processing) {
    await advancePost(id, now);
  }

  return { started: due.length, checked: processing.length };
}

async function recoverStaleClaims(now: Date) {
  const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);
  // A container may or may not exist; an orphaned one expires on its own.
  await prisma.scheduledPost.updateMany({
    where: { status: "CREATING", updatedAt: { lt: staleBefore } },
    data: { status: "SCHEDULED" },
  });
  // Back to PROCESSING, where the container status decides whether it published.
  await prisma.scheduledPost.updateMany({
    where: { status: "PUBLISHING", updatedAt: { lt: staleBefore } },
    data: { status: "PROCESSING" },
  });
}

function loadPost(id: string) {
  return prisma.scheduledPost.findUnique({
    where: { id },
    include: {
      instagramAccount: { select: { instagramId: true, accessToken: true } },
    },
  }) as Promise<PostWithAccount | null>;
}

async function startPost(id: string, now: Date) {
  const claimed = await prisma.scheduledPost.updateMany({
    where: { id, status: "SCHEDULED" },
    data: { status: "CREATING", attempts: { increment: 1 } },
  });
  if (claimed.count !== 1) return;

  const post = await loadPost(id);
  if (!post) return;

  try {
    const accessToken = decryptToken(post.instagramAccount.accessToken);
    const container = await createReelContainer(
      post.instagramAccount.instagramId,
      accessToken,
      {
        videoUrl: post.videoUrl,
        caption: post.caption,
        coverUrl: post.coverUrl,
        thumbOffsetMs: post.thumbOffsetMs,
        shareToFeed: post.shareToFeed,
        trialGraduation: post.trialGraduation,
      }
    );
    await prisma.scheduledPost.update({
      where: { id },
      data: { status: "PROCESSING", containerId: container.id, errorMessage: null },
    });
  } catch (error) {
    await handleError(post, error, now, "SCHEDULED");
  }
}

async function advancePost(id: string, now: Date) {
  const post = await loadPost(id);
  if (!post || post.status !== "PROCESSING" || !post.containerId) return;

  let accessToken: string;
  let statusCode: string;
  let statusDetail: string | undefined;
  try {
    accessToken = decryptToken(post.instagramAccount.accessToken);
    const status = await getContainerStatus(post.containerId, accessToken);
    statusCode = status.status_code;
    statusDetail = status.status;
  } catch (error) {
    const { message, retryable } = describeError(error);
    // Leave the row untouched on a transient failure so updatedAt keeps
    // measuring time since the container was created, and the timeout holds.
    if (!retryable || now.getTime() - post.updatedAt.getTime() > PROCESSING_TIMEOUT_MS) {
      await fail(post, message);
    }
    return;
  }

  switch (statusCode) {
    case "IN_PROGRESS":
      if (now.getTime() - post.updatedAt.getTime() > PROCESSING_TIMEOUT_MS) {
        await fail(
          post,
          "Instagram was still processing the video after an hour. Check the file meets Reels specs (MP4/MOV, H.264 or HEVC, AAC audio, 3 s to 15 min, under 300 MB)."
        );
      }
      return;
    case "ERROR":
      await fail(
        post,
        `Instagram could not process the video${statusDetail ? ` (${statusDetail})` : ""}. Check the URL is a direct, public link to an MP4/MOV that meets Reels specs.`
      );
      return;
    case "EXPIRED":
      await fail(post, "The Instagram upload expired before it could be published.");
      return;
    case "PUBLISHED":
      await prisma.scheduledPost.updateMany({
        where: { id, status: "PROCESSING" },
        data: { status: "PUBLISHED", publishedAt: now, errorMessage: null },
      });
      return;
    case "FINISHED":
      await publish(post, accessToken, now);
      return;
    default:
      return;
  }
}

async function publish(post: PostWithAccount, accessToken: string, now: Date) {
  const claimed = await prisma.scheduledPost.updateMany({
    where: { id: post.id, status: "PROCESSING" },
    data: { status: "PUBLISHING", attempts: { increment: 1 } },
  });
  if (claimed.count !== 1) return;

  let mediaId: string;
  try {
    const published = await publishContainer(
      post.instagramAccount.instagramId,
      accessToken,
      post.containerId!
    );
    mediaId = published.id;
  } catch (error) {
    await handleError({ ...post, attempts: post.attempts + 1 }, error, now, "PROCESSING");
    return;
  }

  await prisma.scheduledPost.update({
    where: { id: post.id },
    data: { status: "PUBLISHED", mediaId, publishedAt: now, errorMessage: null },
  });

  try {
    const permalink = await getMediaPermalink(mediaId, accessToken);
    if (permalink) {
      await prisma.scheduledPost.update({
        where: { id: post.id },
        data: { permalink },
      });
    }
  } catch {
    // The post is live; a missing permalink is cosmetic.
  }
}

function describeError(error: unknown): { message: string; retryable: boolean } {
  if (error instanceof TokenExpiredError) {
    return {
      message: "The Instagram token expired. Reconnect the account in Settings.",
      retryable: false,
    };
  }
  if (error instanceof PermissionError) {
    return {
      message: `Instagram refused the request: ${error.message}. If this account was connected before publishing was added, reconnect it in Settings to grant the content publishing permission.`,
      retryable: false,
    };
  }
  if (error instanceof RateLimitError) {
    return { message: `Instagram rate limit: ${error.message}`, retryable: true };
  }
  if (error instanceof MetaApiError) {
    return { message: `Instagram error: ${error.message}`, retryable: false };
  }
  // Network failures, timeouts, decryption of a token written with another key.
  const message = error instanceof Error ? error.message : "Unknown error";
  return { message, retryable: true };
}

async function handleError(
  post: PostWithAccount,
  error: unknown,
  now: Date,
  retryStatus: "SCHEDULED" | "PROCESSING"
) {
  const { message, retryable } = describeError(error);

  if (!retryable || post.attempts >= MAX_ATTEMPTS) {
    await fail(post, message);
    return;
  }

  await prisma.scheduledPost.update({
    where: { id: post.id },
    data: {
      status: retryStatus,
      errorMessage: message,
      // Push a retry of the create step back so a rate limit has time to clear.
      ...(retryStatus === "SCHEDULED"
        ? { publishAt: new Date(now.getTime() + RETRY_BACKOFF_MS * post.attempts) }
        : {}),
    },
  });
}

async function fail(post: PostWithAccount, message: string) {
  await prisma.scheduledPost.update({
    where: { id: post.id },
    data: { status: "FAILED", errorMessage: message },
  });
  await prisma.operationalEvent
    .create({
      data: {
        source: "WORKER",
        level: "ERROR",
        workspaceId: post.workspaceId,
        message: "Scheduled Reel failed to publish",
        payload: { scheduledPostId: post.id, error: message },
      },
    })
    .catch(() => undefined);
}
