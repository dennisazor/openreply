/**
 * The Claude connector: an MCP server scoped to one workspace.
 *
 * Built per request by /api/mcp after the bearer token resolves to a
 * workspace, so every tool can only see and act on that workspace.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import {
  cancelScheduledPost,
  createScheduledPost,
  listScheduledPosts,
  PLATFORM_OPTIONS,
  SchedulePostError,
  TRIAL_REEL_OPTIONS,
  type ScheduledPostView,
} from "@/lib/publishing/posts";
import { findSounds, SoundsUnavailableError } from "@/lib/publishing/sounds";

const POST_STATUSES = [
  "SCHEDULED",
  "CREATING",
  "PROCESSING",
  "PUBLISHING",
  "PUBLISHED",
  "FAILED",
  "CANCELED",
] as const;

function text(value: unknown, isError = false): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
    ...(isError ? { isError: true } : {}),
  };
}

function viewPost(post: ScheduledPostView) {
  const account =
    post.platform === "THREADS"
      ? post.threadsAccount && `@${post.threadsAccount.username} (Threads)`
      : post.platform === "FACEBOOK"
        ? (post.instagramAccount?.facebookPageName ?? "Facebook Page")
        : post.instagramAccount && `@${post.instagramAccount.username}`;
  return {
    id: post.id,
    groupId: post.groupId,
    platform: post.platform.toLowerCase(),
    account: account ?? "disconnected",
    status: post.status,
    sound: post.audioTitle ?? (post.audioId ? post.audioId : null),
    publishAt: post.publishAt.toISOString(),
    publishedAt: post.publishedAt?.toISOString() ?? null,
    trialReel:
      post.trialGraduation === "MANUAL"
        ? "manual"
        : post.trialGraduation === "SS_PERFORMANCE"
          ? "auto"
          : "off",
    caption: post.caption,
    videoUrl: post.videoUrl,
    permalink: post.permalink,
    error: post.errorMessage,
  };
}

export function createWorkspaceMcpServer(workspaceId: string): McpServer {
  const server = new McpServer({ name: "openreply", version: "1.0.0" });

  server.registerTool(
    "list_instagram_accounts",
    {
      title: "List Instagram accounts",
      description:
        "Instagram accounts connected to this OpenReply workspace. Use a username from here as `account` when scheduling.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const accounts = await prisma.instagramAccount.findMany({
        where: { workspaceId },
        orderBy: { connectedAt: "desc" },
        select: { username: true, name: true, connectedAt: true },
      });
      return text(
        accounts.map((account) => ({
          username: account.username,
          name: account.name,
          connectedAt: account.connectedAt.toISOString(),
        }))
      );
    }
  );

  server.registerTool(
    "schedule_instagram_reel",
    {
      title: "Schedule an Instagram Reel",
      description: [
        "Queue a Reel to publish on Instagram, now or at a set time.",
        "video_url must be a direct, public https link to the MP4/MOV file itself (Instagram downloads it); a share page such as a Google Drive or Dropbox preview link will fail.",
        "Reels specs: H.264 or HEVC video, AAC audio, 3 s to 15 min, under 300 MB, 9:16 recommended.",
        "trial_reel 'manual' or 'auto' posts a trial reel shown to non-followers first; 'auto' lets Instagram share it to followers if it performs well, 'manual' leaves that to you in the Instagram app. Instagram may refuse trial reels on small accounts.",
        "The worker publishes within about a minute of publish_at, then Instagram processes the video, which can take a few minutes.",
        "platforms picks where it goes (default instagram); facebook posts a Reel to the linked Facebook Page (3 to 90 s) and threads posts a video thread (caption up to 500 characters). Each platform gets its own status.",
        "sound_id adds a licensed sound from search_sounds to the Instagram post; set video_volume low for b-roll with a trending sound. Sounds need Facebook connected.",
      ].join(" "),
      inputSchema: {
        video_url: z.string().describe("Direct public https URL of the video file"),
        platforms: z
          .array(z.enum(PLATFORM_OPTIONS))
          .optional()
          .describe("Where to post: instagram, facebook, threads. Default [instagram]."),
        sound_id: z.string().optional().describe("Sound id from search_sounds (Instagram only)"),
        sound_title: z.string().optional().describe("The sound's title, shown in the calendar"),
        sound_volume: z.number().int().min(1).max(100).optional().describe("Sound volume 1-100, default 100"),
        video_volume: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Original video audio volume 1-100, default 100. Use 1 for b-roll under a sound."),
        caption: z
          .string()
          .optional()
          .describe("Caption, up to 2200 characters, 30 hashtags, 20 @ tags"),
        publish_at: z
          .string()
          .optional()
          .describe(
            "ISO 8601 time with timezone offset, e.g. 2026-11-10T18:00:00-05:00. Omit to publish now."
          ),
        trial_reel: z
          .enum(TRIAL_REEL_OPTIONS)
          .optional()
          .describe("off (default), manual, or auto"),
        share_to_feed: z
          .boolean()
          .optional()
          .describe("Also show on the profile grid. Default true. Ignored for trial reels."),
        cover_url: z
          .string()
          .optional()
          .describe("Public https URL of a JPEG cover image"),
        thumb_offset_ms: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Frame to use as the cover, in milliseconds. cover_url wins if both are set."),
        account: z
          .string()
          .optional()
          .describe("Instagram username to post as. Defaults to the most recently connected account."),
      },
    },
    async (args) => {
      let instagramAccountId: string | undefined;
      if (args.account) {
        const username = args.account.replace(/^@/, "");
        const account = await prisma.instagramAccount.findFirst({
          where: { workspaceId, username: { equals: username, mode: "insensitive" } },
          select: { id: true },
        });
        if (!account) {
          return text(`@${username} is not connected to this workspace.`, true);
        }
        instagramAccountId = account.id;
      }

      try {
        const rows = await createScheduledPost(workspaceId, {
          instagramAccountId,
          platforms: args.platforms,
          videoUrl: args.video_url,
          caption: args.caption,
          publishAt: args.publish_at,
          trialReel: args.trial_reel,
          shareToFeed: args.share_to_feed,
          coverUrl: args.cover_url,
          thumbOffsetMs: args.thumb_offset_ms,
          audioId: args.sound_id,
          audioTitle: args.sound_title,
          audioVolume: args.sound_volume,
          videoVolume: args.video_volume,
        });
        return text({ scheduled: rows.map(viewPost) });
      } catch (error) {
        if (error instanceof SchedulePostError) return text(error.message, true);
        throw error;
      }
    }
  );

  server.registerTool(
    "search_sounds",
    {
      title: "Search Instagram sounds",
      description:
        "Licensed sounds from Instagram's Audio API to attach to an Instagram Reel. With no query it returns what is trending. music is cleared catalog music; original_sound is creators' original audio. Pass a result's id as sound_id to schedule_instagram_reel. Needs Facebook connected.",
      inputSchema: {
        query: z.string().optional().describe("Search text. Omit for trending."),
        type: z.enum(["music", "original_sound"]).optional().describe("Default music"),
        account: z.string().optional().describe("Instagram username. Defaults to the most recent."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      let instagramAccountId: string | undefined;
      if (args.account) {
        const account = await prisma.instagramAccount.findFirst({
          where: {
            workspaceId,
            username: { equals: args.account.replace(/^@/, ""), mode: "insensitive" },
          },
          select: { id: true },
        });
        if (!account) return text(`@${args.account} is not connected to this workspace.`, true);
        instagramAccountId = account.id;
      }
      try {
        const sounds = await findSounds(workspaceId, {
          type: args.type,
          query: args.query,
          instagramAccountId,
        });
        return text(
          sounds.map((s) => ({
            id: s.id,
            title: s.title,
            artist: s.artist,
            seconds: s.durationMs ? Math.round(s.durationMs / 1000) : null,
            listen: s.instagramLink ?? s.previewUrl,
          }))
        );
      } catch (error) {
        if (error instanceof SoundsUnavailableError) return text(error.message, true);
        throw error;
      }
    }
  );

  server.registerTool(
    "list_scheduled_posts",
    {
      title: "List scheduled posts",
      description:
        "Scheduled, in-progress, published and failed Reels for this workspace, newest publish time first. A failed post includes the reason.",
      inputSchema: {
        status: z.enum(POST_STATUSES).optional().describe("Filter by status"),
        limit: z.number().int().min(1).max(200).optional().describe("Default 50"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const posts = await listScheduledPosts(workspaceId, {
        status: args.status,
        limit: args.limit,
      });
      return text(posts.map(viewPost));
    }
  );

  server.registerTool(
    "cancel_scheduled_post",
    {
      title: "Cancel a scheduled post",
      description:
        "Cancel a post that has not started publishing (status SCHEDULED). Posts already uploading or published cannot be cancelled here.",
      inputSchema: { id: z.string().describe("Post id from list_scheduled_posts") },
      annotations: { destructiveHint: true },
    },
    async (args) => {
      const canceled = await cancelScheduledPost(workspaceId, args.id);
      return canceled
        ? text(`Canceled ${args.id}.`)
        : text(
            "Nothing canceled: no post with that id is still SCHEDULED in this workspace.",
            true
          );
    }
  );

  return server;
}
