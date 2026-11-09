/**
 * Scheduled Reels: validation, creation, listing and cancelling.
 *
 * Shared by the dashboard API (/api/posts) and the Claude connector
 * (/api/mcp) so both apply the same rules. The worker's publish sweep
 * (lib/publishing/publisher.ts) does the actual publishing.
 */

import { z } from "zod";
import type { ScheduledPostStatus } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";

// Limits from Meta's IG User Media reference.
const MAX_CAPTION_CHARS = 2200;
const MAX_HASHTAGS = 30;
const MAX_MENTIONS = 20;
// Allow a small clock skew between the browser or Claude and the server.
const PAST_TOLERANCE_MS = 5 * 60_000;

const httpsUrl = z
  .string()
  .trim()
  .url()
  .refine((value) => value.startsWith("https://"), {
    message: "Must be a public https:// URL",
  });

export const TRIAL_REEL_OPTIONS = ["off", "manual", "auto"] as const;

export const schedulePostSchema = z
  .object({
    instagramAccountId: z.string().min(1).optional(),
    videoUrl: httpsUrl,
    caption: z.string().max(MAX_CAPTION_CHARS).default(""),
    coverUrl: httpsUrl.optional(),
    thumbOffsetMs: z.number().int().min(0).optional(),
    shareToFeed: z.boolean().default(true),
    /** off = normal reel; manual / auto = trial reel graduated by hand or by performance. */
    trialReel: z.enum(TRIAL_REEL_OPTIONS).default("off"),
    /** Omit to publish on the next sweep (within about a minute). */
    publishAt: z.coerce.date().optional(),
  })
  .superRefine((value, ctx) => {
    const hashtags = value.caption.match(/#[^\s#]+/g)?.length ?? 0;
    if (hashtags > MAX_HASHTAGS) {
      ctx.addIssue({
        code: "custom",
        path: ["caption"],
        message: `Instagram allows at most ${MAX_HASHTAGS} hashtags (found ${hashtags})`,
      });
    }
    const mentions = value.caption.match(/(^|\s)@[\w.]+/g)?.length ?? 0;
    if (mentions > MAX_MENTIONS) {
      ctx.addIssue({
        code: "custom",
        path: ["caption"],
        message: `Instagram allows at most ${MAX_MENTIONS} @ tags (found ${mentions})`,
      });
    }
    if (
      value.publishAt &&
      value.publishAt.getTime() < Date.now() - PAST_TOLERANCE_MS
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["publishAt"],
        message: "Publish time is in the past",
      });
    }
  });

export type SchedulePostInput = z.input<typeof schedulePostSchema>;

export class SchedulePostError extends Error {}

const postSelect = {
  id: true,
  status: true,
  caption: true,
  videoUrl: true,
  trialGraduation: true,
  shareToFeed: true,
  publishAt: true,
  publishedAt: true,
  permalink: true,
  errorMessage: true,
  createdAt: true,
  instagramAccount: { select: { id: true, username: true } },
} as const;

/** Validates input and resolves the account, scoped to the workspace so one
 * workspace can never post as another's account. */
async function preparePostData(workspaceId: string, rawInput: SchedulePostInput) {
  const parsed = schedulePostSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new SchedulePostError(
      parsed.error.issues
        .map((issue) =>
          issue.path.length
            ? `${issue.path.join(".")}: ${issue.message}`
            : issue.message
        )
        .join("; ")
    );
  }
  const input = parsed.data;

  const account = await prisma.instagramAccount.findFirst({
    where: input.instagramAccountId
      ? { id: input.instagramAccountId, workspaceId }
      : { workspaceId },
    orderBy: { connectedAt: "desc" },
    select: { id: true },
  });
  if (!account) {
    throw new SchedulePostError(
      input.instagramAccountId
        ? "That Instagram account is not connected to this workspace"
        : "No Instagram account is connected. Connect one in Settings first."
    );
  }

  return {
    instagramAccountId: account.id,
    videoUrl: input.videoUrl,
    caption: input.caption,
    coverUrl: input.coverUrl ?? null,
    thumbOffsetMs: input.thumbOffsetMs ?? null,
    shareToFeed: input.shareToFeed,
    trialGraduation:
      input.trialReel === "manual"
        ? ("MANUAL" as const)
        : input.trialReel === "auto"
          ? ("SS_PERFORMANCE" as const)
          : null,
    publishAt: input.publishAt ?? new Date(),
  };
}

export async function createScheduledPost(
  workspaceId: string,
  rawInput: SchedulePostInput
) {
  const data = await preparePostData(workspaceId, rawInput);
  return prisma.scheduledPost.create({
    data: { workspaceId, ...data },
    select: postSelect,
  });
}

/**
 * Replaces a post that has not started publishing (SCHEDULED), or re-queues
 * one that FAILED, with fresh attempts. The status guard means a post the
 * worker has already claimed is never changed underneath it.
 */
export async function updateScheduledPost(
  workspaceId: string,
  id: string,
  rawInput: SchedulePostInput
) {
  const data = await preparePostData(workspaceId, rawInput);
  const result = await prisma.scheduledPost.updateMany({
    where: { id, workspaceId, status: { in: ["SCHEDULED", "FAILED"] } },
    data: {
      ...data,
      status: "SCHEDULED",
      attempts: 0,
      containerId: null,
      errorMessage: null,
    },
  });
  if (result.count !== 1) {
    throw new SchedulePostError(
      "This post has already started publishing, so it can no longer be edited."
    );
  }
  return prisma.scheduledPost.findFirstOrThrow({
    where: { id, workspaceId },
    select: postSelect,
  });
}

export async function listScheduledPosts(
  workspaceId: string,
  options: { status?: ScheduledPostStatus; limit?: number } = {}
) {
  return prisma.scheduledPost.findMany({
    where: { workspaceId, ...(options.status ? { status: options.status } : {}) },
    orderBy: { publishAt: "desc" },
    take: Math.min(Math.max(options.limit ?? 50, 1), 200),
    select: postSelect,
  });
}

/**
 * Cancels a post that has not started publishing. Returns false when the post
 * does not exist in this workspace or is already past SCHEDULED.
 */
export async function cancelScheduledPost(workspaceId: string, id: string) {
  const result = await prisma.scheduledPost.updateMany({
    where: { id, workspaceId, status: "SCHEDULED" },
    data: { status: "CANCELED" },
  });
  return result.count === 1;
}

export type ScheduledPostView = Awaited<
  ReturnType<typeof listScheduledPosts>
>[number];
