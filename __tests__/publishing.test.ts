import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    apiToken: { findUnique: vi.fn(), update: vi.fn() },
    instagramAccount: { findFirst: vi.fn() },
    threadsAccount: { findFirst: vi.fn() },
    scheduledPost: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));
vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import {
  createScheduledPost,
  schedulePostSchema,
  SchedulePostError,
  updateScheduledPost,
} from "@/lib/publishing/posts";
import {
  fromInputs,
  groupPosts,
  groupStatus,
  monthGrid,
  postsOnDay,
  startOfWeek,
  weekDays,
  type PostRow,
} from "@/lib/publishing/calendar";
import { authenticateApiToken, generateApiToken, hashApiToken } from "@/lib/api-tokens";
import { createReelContainer } from "@/lib/meta/client";

const VIDEO = "https://cdn.example.com/a.mp4";
const IG_WITH_FB = { id: "acc_1", facebookPageId: "page_1", facebookPageToken: "enc" };
const IG_ONLY = { id: "acc_1", facebookPageId: null, facebookPageToken: null };

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.$transaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops));
  mockPrisma.scheduledPost.create.mockImplementation(async ({ data }: { data: object }) => data);
});

describe("schedulePostSchema", () => {
  const valid = { videoUrl: VIDEO };

  it("accepts a minimal reel and fills defaults", () => {
    const parsed = schedulePostSchema.parse(valid);
    expect(parsed).toMatchObject({ caption: "", shareToFeed: true, trialReel: "off", platforms: ["instagram"] });
  });

  it("rejects a non-https video URL", () => {
    expect(schedulePostSchema.safeParse({ videoUrl: "http://x.com/a.mp4" }).success).toBe(false);
  });

  it("rejects more than 30 hashtags", () => {
    const caption = Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(" ");
    expect(schedulePostSchema.safeParse({ ...valid, caption }).success).toBe(false);
  });

  it("holds Threads to 500 characters but not Instagram alone", () => {
    const caption = "x".repeat(600);
    expect(schedulePostSchema.safeParse({ ...valid, caption }).success).toBe(true);
    expect(
      schedulePostSchema.safeParse({ ...valid, caption, platforms: ["instagram", "threads"] }).success
    ).toBe(false);
  });

  it("rejects a publish time well in the past, allows small clock skew", () => {
    const past = new Date(Date.now() - 60 * 60_000).toISOString();
    const skew = new Date(Date.now() - 60_000).toISOString();
    expect(schedulePostSchema.safeParse({ ...valid, publishAt: past }).success).toBe(false);
    expect(schedulePostSchema.safeParse({ ...valid, publishAt: skew }).success).toBe(true);
  });

  it("rejects an unknown trial mode or platform", () => {
    expect(schedulePostSchema.safeParse({ ...valid, trialReel: "maybe" }).success).toBe(false);
    expect(schedulePostSchema.safeParse({ ...valid, platforms: ["myspace"] }).success).toBe(false);
  });
});

describe("createScheduledPost", () => {
  it("creates one row per platform sharing a groupId, with Instagram-only options kept to Instagram", async () => {
    mockPrisma.instagramAccount.findFirst.mockResolvedValue(IG_WITH_FB);
    mockPrisma.threadsAccount.findFirst.mockResolvedValue({ id: "th_1" });

    const rows = (await createScheduledPost("ws_1", {
      videoUrl: VIDEO,
      platforms: ["instagram", "facebook", "threads"],
      trialReel: "auto",
      audioId: "aud_1",
      audioTitle: "Trending",
      videoVolume: 1,
    })) as unknown as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.groupId)).size).toBe(1);
    const byPlatform = Object.fromEntries(rows.map((r) => [r.platform, r]));
    expect(byPlatform.INSTAGRAM).toMatchObject({
      instagramAccountId: "acc_1",
      trialGraduation: "SS_PERFORMANCE",
      audioId: "aud_1",
      videoVolume: 1,
    });
    expect(byPlatform.FACEBOOK).toMatchObject({ instagramAccountId: "acc_1", trialGraduation: null, audioId: null });
    expect(byPlatform.THREADS).toMatchObject({ instagramAccountId: null, threadsAccountId: "th_1", audioId: null });
  });

  it("refuses Facebook, or a sound, without the Facebook connection", async () => {
    mockPrisma.instagramAccount.findFirst.mockResolvedValue(IG_ONLY);
    await expect(
      createScheduledPost("ws_1", { videoUrl: VIDEO, platforms: ["facebook"] })
    ).rejects.toThrow(/Connect Facebook/);
    await expect(
      createScheduledPost("ws_1", { videoUrl: VIDEO, audioId: "aud_1" })
    ).rejects.toThrow(/Sounds need Facebook/);
  });

  it("refuses Threads without a connected Threads account", async () => {
    mockPrisma.threadsAccount.findFirst.mockResolvedValue(null);
    await expect(
      createScheduledPost("ws_1", { videoUrl: VIDEO, platforms: ["threads"] })
    ).rejects.toThrow(/Connect Threads/);
  });
});

describe("updateScheduledPost", () => {
  beforeEach(() => {
    mockPrisma.instagramAccount.findFirst.mockResolvedValue(IG_WITH_FB);
    mockPrisma.scheduledPost.findFirst.mockResolvedValue({ id: "p1", groupId: "g1" });
    mockPrisma.scheduledPost.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.scheduledPost.findMany.mockResolvedValueOnce([
      { id: "p1", platform: "INSTAGRAM", status: "FAILED" },
      { id: "p2", platform: "FACEBOOK", status: "SCHEDULED" },
      { id: "p3", platform: "THREADS", status: "PUBLISHED" },
    ]);
    mockPrisma.scheduledPost.findMany.mockResolvedValueOnce([]);
  });

  it("re-queues editable rows with fresh attempts, cancels unticked ones, leaves published ones", async () => {
    await updateScheduledPost("ws_1", "p1", { videoUrl: VIDEO, platforms: ["instagram"] });

    const calls = mockPrisma.scheduledPost.updateMany.mock.calls.map((c) => c[0]);
    const requeue = calls.find((c) => c.where.id === "p1");
    expect(requeue.where.status).toEqual({ in: ["SCHEDULED", "FAILED"] });
    expect(requeue.data).toMatchObject({ status: "SCHEDULED", attempts: 0, containerId: null, errorMessage: null });

    const cancel = calls.find((c) => c.data.status === "CANCELED");
    expect(cancel.where.id).toEqual({ in: ["p2"] });
    expect(calls.some((c) => JSON.stringify(c.where).includes("p3"))).toBe(false);
  });

  it("adds a row for a newly ticked platform", async () => {
    mockPrisma.threadsAccount.findFirst.mockResolvedValue({ id: "th_1" });
    mockPrisma.scheduledPost.findMany.mockReset();
    mockPrisma.scheduledPost.findMany
      .mockResolvedValueOnce([{ id: "p1", platform: "INSTAGRAM", status: "SCHEDULED" }])
      .mockResolvedValueOnce([]);

    await updateScheduledPost("ws_1", "p1", { videoUrl: VIDEO, platforms: ["instagram", "threads"] });

    expect(mockPrisma.scheduledPost.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ workspaceId: "ws_1", groupId: "g1", platform: "THREADS" }),
    });
  });

  it("refuses when every row already started publishing", async () => {
    mockPrisma.scheduledPost.findMany.mockReset();
    mockPrisma.scheduledPost.findMany.mockResolvedValueOnce([
      { id: "p1", platform: "INSTAGRAM", status: "PUBLISHING" },
    ]);
    await expect(
      updateScheduledPost("ws_1", "p1", { videoUrl: VIDEO })
    ).rejects.toBeInstanceOf(SchedulePostError);
  });
});

describe("calendar helpers", () => {
  const base = {
    groupId: null,
    platform: "INSTAGRAM" as const,
    caption: "",
    videoUrl: VIDEO,
    trialGraduation: null,
    shareToFeed: true,
    audioId: null,
    audioTitle: null,
    audioVolume: null,
    videoVolume: null,
    publishedAt: null,
    permalink: null,
    errorMessage: null,
    instagramAccount: { id: "a", username: "u", facebookPageName: null },
    threadsAccount: null,
  };

  it("starts weeks on Monday", () => {
    // Sunday Nov 15 2026 belongs to the week of Monday Nov 9.
    const start = startOfWeek(new Date(2026, 10, 15, 21, 30));
    expect([start.getFullYear(), start.getMonth(), start.getDate(), start.getDay()]).toEqual([2026, 10, 9, 1]);
    expect(weekDays(new Date(2026, 10, 11)).map((d) => d.getDate())).toEqual([9, 10, 11, 12, 13, 14, 15]);
  });

  it("builds a six-week Monday-first month grid", () => {
    const grid = monthGrid(new Date(2026, 10, 20));
    expect(grid).toHaveLength(42);
    expect(grid[0].getDay()).toBe(1);
    expect([grid[0].getMonth(), grid[0].getDate()]).toEqual([9, 26]);
  });

  it("combines local date and time inputs, and needs both", () => {
    const when = fromInputs("2026-11-10", "18:05");
    expect(when && [when.getDate(), when.getHours(), when.getMinutes()]).toEqual([10, 18, 5]);
    expect(fromInputs("2026-11-10", "")).toBeNull();
  });

  it("places posts on their day, sorted, without canceled ones", () => {
    const posts: PostRow[] = [
      { ...base, id: "late", status: "SCHEDULED", publishAt: new Date(2026, 10, 10, 18).toISOString() },
      { ...base, id: "early", status: "SCHEDULED", publishAt: new Date(2026, 10, 10, 9).toISOString() },
      { ...base, id: "gone", status: "CANCELED", publishAt: new Date(2026, 10, 10, 12).toISOString() },
      { ...base, id: "other", status: "SCHEDULED", publishAt: new Date(2026, 10, 11, 9).toISOString() },
    ];
    expect(postsOnDay(posts, new Date(2026, 10, 10)).map((p) => p.id)).toEqual(["early", "late"]);
  });

  it("groups a cross-post into one card led by Instagram, with the worst status", () => {
    const at = new Date(2026, 10, 10, 18).toISOString();
    const groups = groupPosts([
      { ...base, id: "t", groupId: "g", platform: "THREADS", status: "PUBLISHED", publishAt: at },
      { ...base, id: "i", groupId: "g", platform: "INSTAGRAM", status: "FAILED", publishAt: at },
      { ...base, id: "f", groupId: "g", platform: "FACEBOOK", status: "CANCELED", publishAt: at },
      { ...base, id: "solo", status: "SCHEDULED", publishAt: at },
    ]);
    expect(groups).toHaveLength(2);
    const cross = groups.find((g) => g.key === "g")!;
    expect(cross.lead.id).toBe("i");
    expect(cross.rows.map((r) => r.platform)).toEqual(["INSTAGRAM", "THREADS"]);
    expect(groupStatus(cross)).toBe("FAILED");
  });
});

describe("createReelContainer", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ id: "c1" }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends trial_params and leaves share_to_feed out for a trial reel", async () => {
    await createReelContainer("ig_1", "tok", {
      videoUrl: VIDEO,
      caption: "hi",
      shareToFeed: true,
      trialGraduation: "MANUAL",
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/graph\.instagram\.com\/v[\d.]+\/ig_1\/media$/);
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body)).toEqual({
      media_type: "REELS",
      video_url: VIDEO,
      caption: "hi",
      trial_params: { graduation_strategy: "MANUAL" },
    });
  });

  it("sends share_to_feed for a normal reel", async () => {
    await createReelContainer("ig_1", "tok", { videoUrl: VIDEO, shareToFeed: false });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.share_to_feed).toBe(false);
    expect(body.trial_params).toBeUndefined();
  });

  it("goes through graph.facebook.com with audio_configuration for a sound", async () => {
    await createReelContainer(
      "ig_1",
      "pagetok",
      { videoUrl: VIDEO, audio: { audioId: "aud_1", audioVolume: 90, videoVolume: 1 } },
      "facebook"
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/graph\.facebook\.com\/v[\d.]+\/ig_1\/media$/);
    expect(JSON.parse(JSON.parse(init.body).audio_configuration)).toEqual({
      audio_id: "aud_1",
      audio_volume: 90,
      video_volume: 1,
    });
  });
});

describe("api tokens", () => {
  it("generates prefixed tokens and stores only the hash", () => {
    const { token, tokenHash, prefix } = generateApiToken();
    expect(token).toMatch(/^orp_[A-Za-z0-9_-]{43}$/);
    expect(tokenHash).toBe(hashApiToken(token));
    expect(tokenHash).not.toContain(token);
    expect(token.startsWith(prefix)).toBe(true);
  });

  it("rejects missing, malformed and revoked tokens", async () => {
    expect(await authenticateApiToken(null)).toBeNull();
    expect(await authenticateApiToken("Bearer sk_other")).toBeNull();
    expect(mockPrisma.apiToken.findUnique).not.toHaveBeenCalled();

    mockPrisma.apiToken.findUnique.mockResolvedValue({
      id: "t1",
      workspaceId: "ws_1",
      revokedAt: new Date(),
      lastUsedAt: null,
    });
    expect(await authenticateApiToken("Bearer orp_abc")).toBeNull();
  });

  it("resolves a live token to its workspace by hash", async () => {
    mockPrisma.apiToken.findUnique.mockResolvedValue({
      id: "t1",
      workspaceId: "ws_1",
      revokedAt: null,
      lastUsedAt: new Date(),
    });
    expect(await authenticateApiToken("Bearer orp_abc")).toEqual({
      workspaceId: "ws_1",
      tokenId: "t1",
    });
    expect(mockPrisma.apiToken.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: hashApiToken("orp_abc") } })
    );
  });
});
