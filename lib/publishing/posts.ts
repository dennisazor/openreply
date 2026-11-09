/**
 * Scheduled posts: validation, creation, editing, listing and cancelling.
 *
 * One post sent to several platforms becomes one ScheduledPost row per
 * platform sharing a groupId; each row keeps its own status and retries.
 * Shared by the dashboard API (/api/posts) and the Claude connector
 * (/api/mcp) so both apply the same rules. The worker's publish sweep
 * (lib/publishing/publisher.ts) does the actual publishing.
 */

import { randomUUID } from "crypto";
import { z } from "zod";
import type { PostPlatform, ScheduledPostStatus } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { THREADS_TEXT_LIMIT } from "@/lib/meta/threads";

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
export const PLATFORM_OPTIONS = ["instagram", "facebook", "threads"] as const;
export type PlatformOption = (typeof PLATFORM_OPTIONS)[number];

const PLATFORM_ENUM: Record<PlatformOption, PostPlatform> = {
  instagram: "INSTAGRAM",
  facebook: "FACEBOOK",
  threads: "THREADS",
};

const volume = z.number().int().min(1).max(100);

export const schedulePostSchema = z
  .object({
    instagramAccountId: z.string().min(1).optional(),
    platforms: z.array(z.enum(PLATFORM_OPTIONS)).min(1).default(["instagram"]),
    videoUrl: httpsUrl,
    caption: z.string().max(MAX_CAPTION_CHARS).default(""),
    coverUrl: httpsUrl.optional(),
    thumbOffsetMs: z.number().int().min(0).optional(),
    shareToFeed: z.boolean().default(true),
    /** off = normal reel; manual / auto = trial reel graduated by hand or by performance. Instagram only. */
    trialReel: z.enum(TRIAL_REEL_OPTIONS).default("off"),
    /** Licensed sound from the Instagram Audio API. Instagram only; needs Facebook connected. */
    audioId: z.string().min(1).optional(),
    audioTitle: z.string().max(200).optional(),
    audioVolume: volume.optional(),
    videoVolume: volume.optional(),
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
    if (value.platforms.includes("threads") && value.caption.length > THREADS_TEXT_LIMIT) {
      ctx.addIssue({
        code: "custom",
        path: ["caption"],
        message: `Threads allows at most ${THREADS_TEXT_LIMIT} characters (this is ${value.caption.length})`,
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
  groupId: true,
  platform: true,
  status: true,
  caption: true,
  videoUrl: true,
  trialGraduation: true,
  shareToFeed: true,
  audioId: true,
  audioTitle: true,
  audioVolume: true,
  videoVolume: true,
  publishAt: true,
  publishedAt: true,
  permalink: true,
  errorMessage: true,
  createdAt: true,
  instagramAccount: { select: { id: true, username: true, facebookPageName: true } },
  threadsAccount: { select: { id: true, username: true } },
} as const;

function parse(rawInput: SchedulePostInput) {
  const parsed = schedulePostSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new SchedulePostError(
      parsed.error.issues
        .map((issue) =>
          issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message
        )
        .join("; ")
    );
  }
  return parsed.data;
}

type ParsedInput = ReturnType<typeof parse>;

/** Resolves every account the chosen platforms need, scoped to the workspace. */
async function resolveTargets(workspaceId: string, input: ParsedInput) {
  const needsInstagram =
    input.platforms.includes("instagram") || input.platforms.includes("facebook");

  const instagramAccount = needsInstagram
    ? await prisma.instagramAccount.findFirst({
        where: input.instagramAccountId
          ? { id: input.instagramAccountId, workspaceId }
          : { workspaceId },
        orderBy: { connectedAt: "desc" },
        select: { id: true, facebookPageId: true, facebookPageToken: true },
      })
    : null;
  if (needsInstagram && !instagramAccount) {
    throw new SchedulePostError(
      input.instagramAccountId
        ? "That Instagram account is not connected to this workspace"
        : "No Instagram account is connected. Connect one in Settings first."
    );
  }

  const hasFacebook = Boolean(instagramAccount?.facebookPageId && instagramAccount.facebookPageToken);
  if (input.platforms.includes("facebook") && !hasFacebook) {
    throw new SchedulePostError("Connect Facebook in Settings to post to your Page.");
  }
  if (input.audioId && input.platforms.includes("instagram") && !hasFacebook) {
    throw new SchedulePostError("Sounds need Facebook connected. Connect Facebook in Settings first.");
  }

  const threadsAccount = input.platforms.includes("threads")
    ? await prisma.threadsAccount.findFirst({
        where: { workspaceId },
        orderBy: { connectedAt: "desc" },
        select: { id: true },
      })
    : null;
  if (input.platforms.includes("threads") && !threadsAccount) {
    throw new SchedulePostError("Connect Threads in Settings to post there.");
  }

  return { instagramAccountId: instagramAccount?.id ?? null, threadsAccountId: threadsAccount?.id ?? null };
}

/** The row data for one platform. Instagram-only options are dropped elsewhere. */
function rowData(
  input: ParsedInput,
  platform: PlatformOption,
  targets: { instagramAccountId: string | null; threadsAccountId: string | null }
) {
  const instagram = platform === "instagram";
  return {
    platform: PLATFORM_ENUM[platform],
    instagramAccountId: platform === "threads" ? null : targets.instagramAccountId,
    threadsAccountId: platform === "threads" ? targets.threadsAccountId : null,
    videoUrl: input.videoUrl,
    caption: input.caption,
    coverUrl: instagram ? (input.coverUrl ?? null) : null,
    thumbOffsetMs: instagram ? (input.thumbOffsetMs ?? null) : null,
    shareToFeed: input.shareToFeed,
    trialGraduation:
      instagram && input.trialReel === "manual"
        ? ("MANUAL" as const)
        : instagram && input.trialReel === "auto"
          ? ("SS_PERFORMANCE" as const)
          : null,
    audioId: instagram ? (input.audioId ?? null) : null,
    audioTitle: instagram && input.audioId ? (input.audioTitle ?? null) : null,
    audioVolume: instagram && input.audioId ? (input.audioVolume ?? null) : null,
    videoVolume: instagram && input.audioId ? (input.videoVolume ?? null) : null,
    publishAt: input.publishAt ?? new Date(),
  };
}

export async function createScheduledPost(workspaceId: string, rawInput: SchedulePostInput) {
  const input = parse(rawInput);
  const targets = await resolveTargets(workspaceId, input);
  const platforms = [...new Set(input.platforms)];
  const groupId = randomUUID();

  return prisma.$transaction(
    platforms.map((platform) =>
      prisma.scheduledPost.create({
        data: { workspaceId, groupId, ...rowData(input, platform, targets) },
        select: postSelect,
      })
    )
  );
}

const EDITABLE: ScheduledPostStatus[] = ["SCHEDULED", "FAILED"];

/**
 * Edits the post `id` belongs to (its whole group). Rows that have not started
 * publishing (SCHEDULED) or FAILED are replaced and re-queued with fresh
 * attempts; platforms newly ticked get a row; editable rows whose platform was
 * unticked are canceled. Rows already publishing or published are left alone.
 */
export async function updateScheduledPost(
  workspaceId: string,
  id: string,
  rawInput: SchedulePostInput
) {
  const input = parse(rawInput);
  const anchor = await prisma.scheduledPost.findFirst({
    where: { id, workspaceId },
    select: { id: true, groupId: true },
  });
  if (!anchor) throw new SchedulePostError("That post does not exist in this workspace.");

  const groupId = anchor.groupId ?? anchor.id;
  const rows = await prisma.scheduledPost.findMany({
    where: anchor.groupId ? { groupId: anchor.groupId, workspaceId } : { id: anchor.id, workspaceId },
    select: { id: true, platform: true, status: true },
  });
  if (!rows.some((row) => EDITABLE.includes(row.status))) {
    throw new SchedulePostError(
      "This post has already started publishing, so it can no longer be edited."
    );
  }

  const targets = await resolveTargets(workspaceId, input);
  const wanted = new Set(input.platforms);

  for (const platform of wanted) {
    const row = rows.find((r) => r.platform === PLATFORM_ENUM[platform]);
    if (!row) {
      await prisma.scheduledPost.create({
        data: { workspaceId, groupId, ...rowData(input, platform, targets) },
      });
    } else if (EDITABLE.includes(row.status)) {
      // Guarded: a row the worker claimed in the meantime is left as it is.
      await prisma.scheduledPost.updateMany({
        where: { id: row.id, workspaceId, status: { in: EDITABLE } },
        data: {
          ...rowData(input, platform, targets),
          groupId,
          status: "SCHEDULED",
          attempts: 0,
          containerId: null,
          errorMessage: null,
        },
      });
    }
  }

  const wantedEnums = new Set([...wanted].map((p) => PLATFORM_ENUM[p]));
  const dropped = rows
    .filter((row) => EDITABLE.includes(row.status) && !wantedEnums.has(row.platform))
    .map((row) => row.id);
  if (dropped.length) {
    await prisma.scheduledPost.updateMany({
      where: { id: { in: dropped }, workspaceId, status: { in: EDITABLE } },
      data: { status: "CANCELED" },
    });
  }

  return prisma.scheduledPost.findMany({
    where: { groupId, workspaceId },
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
    take: Math.min(Math.max(options.limit ?? 50, 1), 300),
    select: postSelect,
  });
}

/**
 * Cancels every row of the post `id` belongs to that has not started
 * publishing. Returns false when nothing in the workspace could be canceled.
 */
export async function cancelScheduledPost(workspaceId: string, id: string) {
  const anchor = await prisma.scheduledPost.findFirst({
    where: { id, workspaceId },
    select: { id: true, groupId: true },
  });
  if (!anchor) return false;
  const result = await prisma.scheduledPost.updateMany({
    where: {
      workspaceId,
      status: "SCHEDULED",
      ...(anchor.groupId ? { groupId: anchor.groupId } : { id: anchor.id }),
    },
    data: { status: "CANCELED" },
  });
  return result.count > 0;
}

export type ScheduledPostView = Awaited<ReturnType<typeof listScheduledPosts>>[number];
