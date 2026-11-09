import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    apiToken: { findUnique: vi.fn(), update: vi.fn() },
    instagramAccount: { findFirst: vi.fn() },
    scheduledPost: { updateMany: vi.fn(), findFirstOrThrow: vi.fn() },
  },
}));
vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import {
  schedulePostSchema,
  SchedulePostError,
  updateScheduledPost,
} from "@/lib/publishing/posts";
import {
  fromInputs,
  monthGrid,
  postsOnDay,
  startOfWeek,
  weekDays,
  type PostRow,
} from "@/lib/publishing/calendar";

describe("updateScheduledPost", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.instagramAccount.findFirst.mockResolvedValue({ id: "acc_1" });
  });

  it("only touches SCHEDULED or FAILED posts in the workspace, and resets attempts", async () => {
    mockPrisma.scheduledPost.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.scheduledPost.findFirstOrThrow.mockResolvedValue({ id: "p1" });

    await updateScheduledPost("ws_1", "p1", {
      videoUrl: "https://cdn.example.com/a.mp4",
      trialReel: "auto",
    });

    const call = mockPrisma.scheduledPost.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({
      id: "p1",
      workspaceId: "ws_1",
      status: { in: ["SCHEDULED", "FAILED"] },
    });
    expect(call.data).toMatchObject({
      status: "SCHEDULED",
      attempts: 0,
      containerId: null,
      errorMessage: null,
      trialGraduation: "SS_PERFORMANCE",
    });
  });

  it("refuses a post the worker already claimed", async () => {
    mockPrisma.scheduledPost.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      updateScheduledPost("ws_1", "p1", { videoUrl: "https://cdn.example.com/a.mp4" })
    ).rejects.toBeInstanceOf(SchedulePostError);
  });
});

describe("calendar helpers", () => {
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
    const base = {
      caption: "",
      videoUrl: "https://x/a.mp4",
      trialGraduation: null,
      shareToFeed: true,
      publishedAt: null,
      permalink: null,
      errorMessage: null,
      instagramAccount: { id: "a", username: "u" },
    };
    const posts: PostRow[] = [
      { ...base, id: "late", status: "SCHEDULED", publishAt: new Date(2026, 10, 10, 18).toISOString() },
      { ...base, id: "early", status: "SCHEDULED", publishAt: new Date(2026, 10, 10, 9).toISOString() },
      { ...base, id: "gone", status: "CANCELED", publishAt: new Date(2026, 10, 10, 12).toISOString() },
      { ...base, id: "other", status: "SCHEDULED", publishAt: new Date(2026, 10, 11, 9).toISOString() },
    ];
    expect(postsOnDay(posts, new Date(2026, 10, 10)).map((p) => p.id)).toEqual(["early", "late"]);
  });
});
import { authenticateApiToken, generateApiToken, hashApiToken } from "@/lib/api-tokens";
import { createReelContainer } from "@/lib/meta/client";

describe("schedulePostSchema", () => {
  const valid = { videoUrl: "https://cdn.example.com/reel.mp4" };

  it("accepts a minimal reel and fills defaults", () => {
    const parsed = schedulePostSchema.parse(valid);
    expect(parsed).toMatchObject({ caption: "", shareToFeed: true, trialReel: "off" });
  });

  it("rejects a non-https video URL", () => {
    expect(schedulePostSchema.safeParse({ videoUrl: "http://x.com/a.mp4" }).success).toBe(false);
  });

  it("rejects more than 30 hashtags", () => {
    const caption = Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(" ");
    expect(schedulePostSchema.safeParse({ ...valid, caption }).success).toBe(false);
  });

  it("rejects a publish time well in the past, allows small clock skew", () => {
    const past = new Date(Date.now() - 60 * 60_000).toISOString();
    const skew = new Date(Date.now() - 60_000).toISOString();
    expect(schedulePostSchema.safeParse({ ...valid, publishAt: past }).success).toBe(false);
    expect(schedulePostSchema.safeParse({ ...valid, publishAt: skew }).success).toBe(true);
  });

  it("rejects an unknown trial mode", () => {
    expect(schedulePostSchema.safeParse({ ...valid, trialReel: "maybe" }).success).toBe(false);
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
      videoUrl: "https://cdn.example.com/reel.mp4",
      caption: "hi",
      shareToFeed: true,
      trialGraduation: "MANUAL",
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/graph\.instagram\.com\/v[\d.]+\/ig_1\/media$/);
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body)).toEqual({
      media_type: "REELS",
      video_url: "https://cdn.example.com/reel.mp4",
      caption: "hi",
      trial_params: { graduation_strategy: "MANUAL" },
    });
  });

  it("sends share_to_feed for a normal reel", async () => {
    await createReelContainer("ig_1", "tok", {
      videoUrl: "https://cdn.example.com/reel.mp4",
      shareToFeed: false,
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.share_to_feed).toBe(false);
    expect(body.trial_params).toBeUndefined();
  });
});

describe("api tokens", () => {
  beforeEach(() => vi.clearAllMocks());

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
