/**
 * Publish sweep: moves due ScheduledPosts through each platform's two-step
 * publish flow.
 *
 *   SCHEDULED --claim--> CREATING --container/upload created--> PROCESSING
 *   PROCESSING --ready, claim--> PUBLISHING --published--> PUBLISHED
 *
 * One row per platform (rows of a cross-post share a groupId), so each keeps
 * its own status and retries. The worker runs this once a minute, which is
 * also Meta's recommended status polling cadence. Every transition is a
 * guarded updateMany on the current status, so two workers or overlapping
 * sweeps never act on the same row, and nothing is held in Redis.
 *
 * Double-publish safety: a row only reaches the publish call from PROCESSING
 * after reading the container's status. A container that is already
 * PUBLISHED (a crash after publishing but before saving) is marked done.
 */

import { del } from "@vercel/blob";
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
  type GraphHost,
} from "@/lib/meta/client";
import {
  getPageVideoPermalink,
  getPageVideoStatus,
  publishPageReelFromUrl,
} from "@/lib/meta/facebook";
import { decryptToken } from "@/lib/meta/oauth";
import {
  createThreadsVideo,
  getThreadsContainerStatus,
  getThreadsPermalink,
  publishThreads,
} from "@/lib/meta/threads";

const BATCH_SIZE = 10;
// A post left in a transient claim state this long belongs to a worker that died.
const STALE_CLAIM_MS = 10 * 60_000;
// Processing normally takes minutes; give up well before the 24h container expiry.
const PROCESSING_TIMEOUT_MS = 60 * 60_000;
const MAX_ATTEMPTS = 5;
const RETRY_BACKOFF_MS = 5 * 60_000;

type LoadedPost = ScheduledPost & {
  instagramAccount: {
    instagramId: string;
    accessToken: string;
    facebookPageId: string | null;
    facebookPageToken: string | null;
    facebookIgUserId: string | null;
  } | null;
  threadsAccount: { threadsUserId: string; accessToken: string } | null;
};

type CheckCode = "IN_PROGRESS" | "FINISHED" | "PUBLISHED" | "ERROR" | "EXPIRED";

/** One platform's publish steps. */
interface Adapter {
  create(post: LoadedPost): Promise<string>;
  check(post: LoadedPost, containerId: string): Promise<{ code: CheckCode; detail?: string }>;
  publish(post: LoadedPost, containerId: string): Promise<string>;
  permalink(post: LoadedPost, mediaId: string): Promise<string | null>;
}

/** A setup problem retrying cannot fix (account gone, Facebook not connected). */
class PublishSetupError extends Error {}

function instagramTarget(post: LoadedPost): { via: GraphHost; userId: string; token: string } {
  const account = post.instagramAccount;
  if (!account) throw new PublishSetupError("The Instagram account for this post is no longer connected.");
  // The Facebook connection's Page token does not expire and supports sounds.
  if (account.facebookPageToken && account.facebookIgUserId) {
    return {
      via: "facebook",
      userId: account.facebookIgUserId,
      token: decryptToken(account.facebookPageToken),
    };
  }
  if (post.audioId) {
    throw new PublishSetupError(
      "Posting with a sound needs Facebook connected. Connect Facebook in Settings, then try again."
    );
  }
  return { via: "instagram", userId: account.instagramId, token: decryptToken(account.accessToken) };
}

function pageTarget(post: LoadedPost): { pageId: string; token: string } {
  const account = post.instagramAccount;
  if (!account?.facebookPageId || !account.facebookPageToken) {
    throw new PublishSetupError("No Facebook Page is connected. Connect Facebook in Settings, then try again.");
  }
  return { pageId: account.facebookPageId, token: decryptToken(account.facebookPageToken) };
}

function threadsTarget(post: LoadedPost): { userId: string; token: string } {
  if (!post.threadsAccount) {
    throw new PublishSetupError("No Threads account is connected. Connect Threads in Settings, then try again.");
  }
  return {
    userId: post.threadsAccount.threadsUserId,
    token: decryptToken(post.threadsAccount.accessToken),
  };
}

const ADAPTERS: Record<ScheduledPost["platform"], Adapter> = {
  INSTAGRAM: {
    async create(post) {
      const { via, userId, token } = instagramTarget(post);
      const container = await createReelContainer(
        userId,
        token,
        {
          videoUrl: post.videoUrl,
          caption: post.caption,
          coverUrl: post.coverUrl,
          thumbOffsetMs: post.thumbOffsetMs,
          shareToFeed: post.shareToFeed,
          trialGraduation: post.trialGraduation,
          audio: post.audioId
            ? { audioId: post.audioId, audioVolume: post.audioVolume, videoVolume: post.videoVolume }
            : null,
        },
        via
      );
      return container.id;
    },
    async check(post, containerId) {
      const { via, token } = instagramTarget(post);
      const status = await getContainerStatus(containerId, token, via);
      return { code: status.status_code, detail: status.status };
    },
    async publish(post, containerId) {
      const { via, userId, token } = instagramTarget(post);
      return (await publishContainer(userId, token, containerId, via)).id;
    },
    async permalink(post, mediaId) {
      const { via, token } = instagramTarget(post);
      return getMediaPermalink(mediaId, token, via);
    },
  },

  FACEBOOK: {
    // Facebook publishes as part of the upload; the status check only waits
    // for processing to finish and reports PUBLISHED.
    async create(post) {
      const { pageId, token } = pageTarget(post);
      return publishPageReelFromUrl(pageId, token, {
        videoUrl: post.videoUrl,
        description: post.caption,
      });
    },
    async check(post, videoId) {
      const { token } = pageTarget(post);
      const s = await getPageVideoStatus(videoId, token);
      const failed =
        s.video_status === "error" ||
        s.video_status === "upload_failed" ||
        s.processing_phase?.status === "error" ||
        s.publishing_phase?.status === "error" ||
        s.publishing_phase?.publish_status === "error";
      if (failed) {
        return {
          code: "ERROR",
          detail: s.processing_phase?.error?.message ?? s.uploading_phase?.errors?.[0]?.message,
        };
      }
      if (s.video_status === "expired") return { code: "EXPIRED" };
      if (s.publishing_phase?.publish_status === "published") return { code: "PUBLISHED" };
      return { code: "IN_PROGRESS" };
    },
    async publish(_post, videoId) {
      return videoId;
    },
    async permalink(post, videoId) {
      return getPageVideoPermalink(videoId, pageTarget(post).token);
    },
  },

  THREADS: {
    async create(post) {
      const { userId, token } = threadsTarget(post);
      return (await createThreadsVideo(userId, token, { videoUrl: post.videoUrl, text: post.caption })).id;
    },
    async check(post, containerId) {
      const status = await getThreadsContainerStatus(containerId, threadsTarget(post).token);
      return { code: status.status, detail: status.error_message };
    },
    async publish(post, containerId) {
      const { userId, token } = threadsTarget(post);
      return (await publishThreads(userId, token, containerId)).id;
    },
    async permalink(post, mediaId) {
      return getThreadsPermalink(mediaId, threadsTarget(post).token);
    },
  },
};

const PLATFORM_NAME: Record<ScheduledPost["platform"], string> = {
  INSTAGRAM: "Instagram",
  FACEBOOK: "Facebook",
  THREADS: "Threads",
};

export interface PublishSweepResult {
  started: number;
  checked: number;
}

export async function runPublishSweep(now: Date = new Date()): Promise<PublishSweepResult> {
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
      instagramAccount: {
        select: {
          instagramId: true,
          accessToken: true,
          facebookPageId: true,
          facebookPageToken: true,
          facebookIgUserId: true,
        },
      },
      threadsAccount: { select: { threadsUserId: true, accessToken: true } },
    },
  }) as Promise<LoadedPost | null>;
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
    const containerId = await ADAPTERS[post.platform].create(post);
    await prisma.scheduledPost.update({
      where: { id },
      data: { status: "PROCESSING", containerId, errorMessage: null },
    });
  } catch (error) {
    await handleError(post, error, now, "SCHEDULED");
  }
}

async function advancePost(id: string, now: Date) {
  const post = await loadPost(id);
  if (!post || post.status !== "PROCESSING" || !post.containerId) return;
  const adapter = ADAPTERS[post.platform];

  let code: CheckCode;
  let detail: string | undefined;
  try {
    ({ code, detail } = await adapter.check(post, post.containerId));
  } catch (error) {
    const { message, retryable } = describeError(error);
    // Leave the row untouched on a transient failure so updatedAt keeps
    // measuring time since the container was created, and the timeout holds.
    if (!retryable || now.getTime() - post.updatedAt.getTime() > PROCESSING_TIMEOUT_MS) {
      await fail(post, message);
    }
    return;
  }

  const platform = PLATFORM_NAME[post.platform];
  switch (code) {
    case "IN_PROGRESS":
      if (now.getTime() - post.updatedAt.getTime() > PROCESSING_TIMEOUT_MS) {
        await fail(
          post,
          `${platform} was still processing the video after an hour. Check the file meets the specs (MP4/MOV, H.264 or HEVC, AAC audio).`
        );
      }
      return;
    case "ERROR":
      await fail(
        post,
        `${platform} could not process the video${detail ? ` (${detail})` : ""}. Check the link is a direct, public MP4/MOV that meets the specs.`
      );
      return;
    case "EXPIRED":
      await fail(post, `The ${platform} upload expired before it could be published.`);
      return;
    case "PUBLISHED": {
      // Facebook's container id is the video id; elsewhere the media id is
      // unknown when we only learn of the publish from the container.
      const mediaId = post.platform === "FACEBOOK" ? post.containerId : null;
      const done = await prisma.scheduledPost.updateMany({
        where: { id, status: "PROCESSING" },
        data: { status: "PUBLISHED", publishedAt: now, errorMessage: null, ...(mediaId ? { mediaId } : {}) },
      });
      if (done.count === 1) await afterPublished(post, mediaId);
      return;
    }
    case "FINISHED":
      await publish(post, now);
      return;
  }
}

async function publish(post: LoadedPost, now: Date) {
  const claimed = await prisma.scheduledPost.updateMany({
    where: { id: post.id, status: "PROCESSING" },
    data: { status: "PUBLISHING", attempts: { increment: 1 } },
  });
  if (claimed.count !== 1) return;

  let mediaId: string;
  try {
    mediaId = await ADAPTERS[post.platform].publish(post, post.containerId!);
  } catch (error) {
    await handleError({ ...post, attempts: post.attempts + 1 }, error, now, "PROCESSING");
    return;
  }

  await prisma.scheduledPost.update({
    where: { id: post.id },
    data: { status: "PUBLISHED", mediaId, publishedAt: now, errorMessage: null },
  });
  await afterPublished(post, mediaId);
}

/** Best effort: the post is live, so neither step may fail the row. */
async function afterPublished(post: LoadedPost, mediaId: string | null) {
  if (mediaId) {
    try {
      const permalink = await ADAPTERS[post.platform].permalink(post, mediaId);
      if (permalink) {
        await prisma.scheduledPost.update({ where: { id: post.id }, data: { permalink } });
      }
    } catch {
      // A missing permalink is cosmetic.
    }
  }
  await deleteUploadWhenDone(post.videoUrl);
}

/**
 * Uploaded videos live in Vercel Blob only until every row that uses them is
 * published or canceled. A failed row keeps the file so "Try again" works; the
 * upload's TTL removes it eventually either way.
 */
export async function deleteUploadWhenDone(videoUrl: string) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return;
  let host: string;
  try {
    host = new URL(videoUrl).hostname;
  } catch {
    return;
  }
  if (!host.endsWith(".public.blob.vercel-storage.com")) return;

  const stillNeeded = await prisma.scheduledPost.count({
    where: { videoUrl, status: { notIn: ["PUBLISHED", "CANCELED"] } },
  });
  if (stillNeeded > 0) return;
  await del(videoUrl).catch(() => undefined);
}

function describeError(error: unknown): { message: string; retryable: boolean } {
  if (error instanceof PublishSetupError) {
    return { message: error.message, retryable: false };
  }
  if (error instanceof TokenExpiredError) {
    return {
      message: "The connection's token expired. Reconnect the account in Settings.",
      retryable: false,
    };
  }
  if (error instanceof PermissionError) {
    return {
      message: `The platform refused the request: ${error.message}. If this account was connected before publishing was added, reconnect it in Settings to grant the publishing permission.`,
      retryable: false,
    };
  }
  if (error instanceof RateLimitError) {
    return { message: `Rate limit: ${error.message}`, retryable: true };
  }
  if (error instanceof MetaApiError) {
    return { message: `Platform error: ${error.message}`, retryable: false };
  }
  // Network failures, timeouts, decryption of a token written with another key.
  const message = error instanceof Error ? error.message : "Unknown error";
  return { message, retryable: true };
}

async function handleError(
  post: LoadedPost,
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

async function fail(post: LoadedPost, message: string) {
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
        message: `Scheduled ${PLATFORM_NAME[post.platform]} post failed to publish`,
        payload: { scheduledPostId: post.id, error: message },
      },
    })
    .catch(() => undefined);
}
