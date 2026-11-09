import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockPrisma, meta, fb, threads, mockDel } = vi.hoisted(() => {
  class MetaApiError extends Error {
    constructor(public code: number, _s: unknown, _t: unknown, message: string) {
      super(message);
    }
  }
  class PermissionError extends MetaApiError {
    constructor(message: string) {
      super(100, undefined, undefined, message);
    }
  }
  class RateLimitError extends MetaApiError {
    constructor(message: string) {
      super(4, undefined, undefined, message);
    }
  }
  class TokenExpiredError extends MetaApiError {
    constructor(message: string) {
      super(190, undefined, undefined, message);
    }
  }
  return {
    mockPrisma: {
      scheduledPost: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
        updateMany: vi.fn(),
        update: vi.fn(),
        count: vi.fn(),
      },
      operationalEvent: { create: vi.fn() },
    },
    meta: {
      MetaApiError,
      PermissionError,
      RateLimitError,
      TokenExpiredError,
      createReelContainer: vi.fn(),
      getContainerStatus: vi.fn(),
      publishContainer: vi.fn(),
      getMediaPermalink: vi.fn(),
    },
    fb: {
      publishPageReelFromUrl: vi.fn(),
      getPageVideoStatus: vi.fn(),
      getPageVideoPermalink: vi.fn(),
    },
    threads: {
      createThreadsVideo: vi.fn(),
      getThreadsContainerStatus: vi.fn(),
      publishThreads: vi.fn(),
      getThreadsPermalink: vi.fn(),
    },
    mockDel: vi.fn(),
  };
});

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/meta/client", () => meta);
vi.mock("@/lib/meta/facebook", () => fb);
vi.mock("@/lib/meta/threads", () => threads);
vi.mock("@vercel/blob", () => ({ del: mockDel }));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: (value: string) => `plain:${value}` }));

import { deleteUploadWhenDone, runPublishSweep } from "@/lib/publishing/publisher";

const NOW = new Date("2026-11-09T12:00:00Z");

function post(overrides: Record<string, unknown> = {}) {
  return {
    id: "post_1",
    workspaceId: "ws_1",
    platform: "INSTAGRAM",
    groupId: "g1",
    instagramAccountId: "acc_1",
    threadsAccountId: null,
    videoUrl: "https://cdn.example.com/reel.mp4",
    caption: "hello",
    coverUrl: null,
    thumbOffsetMs: null,
    shareToFeed: true,
    trialGraduation: null,
    audioId: null,
    audioTitle: null,
    audioVolume: null,
    videoVolume: null,
    publishAt: NOW,
    status: "SCHEDULED",
    attempts: 1,
    containerId: null,
    updatedAt: NOW,
    instagramAccount: {
      instagramId: "17841400000000000",
      accessToken: "enc",
      facebookPageId: null,
      facebookPageToken: null,
      facebookIgUserId: null,
    },
    threadsAccount: null,
    ...overrides,
  };
}

const withFacebook = {
  instagramId: "17841400000000000",
  accessToken: "enc",
  facebookPageId: "page_1",
  facebookPageToken: "pagetok",
  facebookIgUserId: "fb_ig_1",
};

// findMany is called twice per sweep: due SCHEDULED posts, then PROCESSING posts.
function sweepFinds(due: string[], processing: string[]) {
  mockPrisma.scheduledPost.findMany
    .mockResolvedValueOnce(due.map((id) => ({ id })))
    .mockResolvedValueOnce(processing.map((id) => ({ id })));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.scheduledPost.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.scheduledPost.count.mockResolvedValue(0);
  mockPrisma.operationalEvent.create.mockResolvedValue({});
  mockDel.mockResolvedValue(undefined);
});

describe("runPublishSweep: create step", () => {
  it("claims a due post, creates a trial reel container, and moves it to PROCESSING", async () => {
    sweepFinds(["post_1"], []);
    mockPrisma.scheduledPost.findUnique.mockResolvedValue(
      post({ status: "CREATING", trialGraduation: "SS_PERFORMANCE" })
    );
    meta.createReelContainer.mockResolvedValue({ id: "container_9" });

    await runPublishSweep(NOW);

    expect(mockPrisma.scheduledPost.updateMany).toHaveBeenCalledWith({
      where: { id: "post_1", status: "SCHEDULED" },
      data: { status: "CREATING", attempts: { increment: 1 } },
    });
    expect(meta.createReelContainer).toHaveBeenCalledWith(
      "17841400000000000",
      "plain:enc",
      expect.objectContaining({ trialGraduation: "SS_PERFORMANCE", caption: "hello", audio: null }),
      "instagram"
    );
    expect(mockPrisma.scheduledPost.update).toHaveBeenCalledWith({
      where: { id: "post_1" },
      data: { status: "PROCESSING", containerId: "container_9", errorMessage: null },
    });
  });

  it("publishes through Facebook with the Page token and the chosen sound when Facebook is linked", async () => {
    sweepFinds(["post_1"], []);
    mockPrisma.scheduledPost.findUnique.mockResolvedValue(
      post({ status: "CREATING", instagramAccount: withFacebook, audioId: "aud_1", audioVolume: 100, videoVolume: 1 })
    );
    meta.createReelContainer.mockResolvedValue({ id: "container_9" });

    await runPublishSweep(NOW);

    expect(meta.createReelContainer).toHaveBeenCalledWith(
      "fb_ig_1",
      "plain:pagetok",
      expect.objectContaining({ audio: { audioId: "aud_1", audioVolume: 100, videoVolume: 1 } }),
      "facebook"
    );
  });

  it("fails a post with a sound when Facebook is not connected, without retrying", async () => {
    sweepFinds(["post_1"], []);
    mockPrisma.scheduledPost.findUnique.mockResolvedValue(post({ status: "CREATING", audioId: "aud_1" }));

    await runPublishSweep(NOW);

    expect(meta.createReelContainer).not.toHaveBeenCalled();
    const update = mockPrisma.scheduledPost.update.mock.calls[0][0];
    expect(update.data.status).toBe("FAILED");
    expect(update.data.errorMessage).toMatch(/needs Facebook connected/);
  });

  it("does nothing when another worker already claimed the post", async () => {
    sweepFinds(["post_1"], []);
    // First two updateMany calls are the stale-claim recoveries; the claim loses.
    mockPrisma.scheduledPost.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 });

    await runPublishSweep(NOW);

    expect(mockPrisma.scheduledPost.findUnique).not.toHaveBeenCalled();
    expect(meta.createReelContainer).not.toHaveBeenCalled();
  });

  it("fails immediately with a reconnect hint on a permission error", async () => {
    sweepFinds(["post_1"], []);
    mockPrisma.scheduledPost.findUnique.mockResolvedValue(post({ status: "CREATING" }));
    meta.createReelContainer.mockRejectedValue(
      new meta.PermissionError("Application does not have permission")
    );

    await runPublishSweep(NOW);

    const update = mockPrisma.scheduledPost.update.mock.calls[0][0];
    expect(update.data.status).toBe("FAILED");
    expect(update.data.errorMessage).toMatch(/reconnect it in Settings/);
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalled();
  });

  it("retries a network error later instead of failing", async () => {
    sweepFinds(["post_1"], []);
    mockPrisma.scheduledPost.findUnique.mockResolvedValue(post({ status: "CREATING", attempts: 1 }));
    meta.createReelContainer.mockRejectedValue(new Error("fetch failed"));

    await runPublishSweep(NOW);

    const update = mockPrisma.scheduledPost.update.mock.calls[0][0];
    expect(update.data.status).toBe("SCHEDULED");
    expect(update.data.publishAt.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("gives up after the attempt cap", async () => {
    sweepFinds(["post_1"], []);
    mockPrisma.scheduledPost.findUnique.mockResolvedValue(post({ status: "CREATING", attempts: 5 }));
    meta.createReelContainer.mockRejectedValue(new Error("fetch failed"));

    await runPublishSweep(NOW);

    expect(mockPrisma.scheduledPost.update.mock.calls[0][0].data.status).toBe("FAILED");
  });
});

describe("runPublishSweep: publish step", () => {
  it("publishes a FINISHED container and records the media id and permalink", async () => {
    sweepFinds([], ["post_1"]);
    mockPrisma.scheduledPost.findUnique.mockResolvedValue(
      post({ status: "PROCESSING", containerId: "container_9" })
    );
    meta.getContainerStatus.mockResolvedValue({ status_code: "FINISHED" });
    meta.publishContainer.mockResolvedValue({ id: "media_5" });
    meta.getMediaPermalink.mockResolvedValue("https://www.instagram.com/reel/abc/");

    await runPublishSweep(NOW);

    expect(meta.publishContainer).toHaveBeenCalledWith(
      "17841400000000000",
      "plain:enc",
      "container_9",
      "instagram"
    );
    expect(mockPrisma.scheduledPost.update).toHaveBeenCalledWith({
      where: { id: "post_1" },
      data: { status: "PUBLISHED", mediaId: "media_5", publishedAt: NOW, errorMessage: null },
    });
    expect(mockPrisma.scheduledPost.update).toHaveBeenCalledWith({
      where: { id: "post_1" },
      data: { permalink: "https://www.instagram.com/reel/abc/" },
    });
  });

  it("never publishes twice: an already PUBLISHED container is just marked done", async () => {
    sweepFinds([], ["post_1"]);
    mockPrisma.scheduledPost.findUnique.mockResolvedValue(
      post({ status: "PROCESSING", containerId: "container_9" })
    );
    meta.getContainerStatus.mockResolvedValue({ status_code: "PUBLISHED" });

    await runPublishSweep(NOW);

    expect(meta.publishContainer).not.toHaveBeenCalled();
    expect(mockPrisma.scheduledPost.updateMany).toHaveBeenCalledWith({
      where: { id: "post_1", status: "PROCESSING" },
      data: { status: "PUBLISHED", publishedAt: NOW, errorMessage: null },
    });
  });

  it("leaves an IN_PROGRESS container alone until the timeout", async () => {
    sweepFinds([], ["post_1"]);
    mockPrisma.scheduledPost.findUnique.mockResolvedValue(
      post({ status: "PROCESSING", containerId: "container_9" })
    );
    meta.getContainerStatus.mockResolvedValue({ status_code: "IN_PROGRESS" });

    await runPublishSweep(NOW);

    expect(mockPrisma.scheduledPost.update).not.toHaveBeenCalled();
    expect(meta.publishContainer).not.toHaveBeenCalled();
  });

  it("fails a container Instagram could not process", async () => {
    sweepFinds([], ["post_1"]);
    mockPrisma.scheduledPost.findUnique.mockResolvedValue(
      post({ status: "PROCESSING", containerId: "container_9" })
    );
    meta.getContainerStatus.mockResolvedValue({ status_code: "ERROR", status: "2207026" });

    await runPublishSweep(NOW);

    const update = mockPrisma.scheduledPost.update.mock.calls[0][0];
    expect(update.data.status).toBe("FAILED");
    expect(update.data.errorMessage).toContain("2207026");
  });
});

describe("runPublishSweep: Facebook Page and Threads", () => {
  it("uploads a Facebook Reel, then marks it published with the video id and permalink", async () => {
    sweepFinds(["post_fb"], []);
    mockPrisma.scheduledPost.findUnique.mockResolvedValueOnce(
      post({ id: "post_fb", platform: "FACEBOOK", status: "CREATING", instagramAccount: withFacebook })
    );
    fb.publishPageReelFromUrl.mockResolvedValue("video_7");

    await runPublishSweep(NOW);

    expect(fb.publishPageReelFromUrl).toHaveBeenCalledWith("page_1", "plain:pagetok", {
      videoUrl: "https://cdn.example.com/reel.mp4",
      description: "hello",
    });

    sweepFinds([], ["post_fb"]);
    mockPrisma.scheduledPost.findUnique.mockResolvedValueOnce(
      post({
        id: "post_fb",
        platform: "FACEBOOK",
        status: "PROCESSING",
        containerId: "video_7",
        instagramAccount: withFacebook,
      })
    );
    fb.getPageVideoStatus.mockResolvedValue({ publishing_phase: { publish_status: "published" } });
    fb.getPageVideoPermalink.mockResolvedValue("https://www.facebook.com/reel/7");

    await runPublishSweep(NOW);

    expect(mockPrisma.scheduledPost.updateMany).toHaveBeenCalledWith({
      where: { id: "post_fb", status: "PROCESSING" },
      data: { status: "PUBLISHED", publishedAt: NOW, errorMessage: null, mediaId: "video_7" },
    });
    expect(mockPrisma.scheduledPost.update).toHaveBeenCalledWith({
      where: { id: "post_fb" },
      data: { permalink: "https://www.facebook.com/reel/7" },
    });
  });

  it("fails a Facebook row when no Page is linked", async () => {
    sweepFinds(["post_fb"], []);
    mockPrisma.scheduledPost.findUnique.mockResolvedValue(
      post({ id: "post_fb", platform: "FACEBOOK", status: "CREATING" })
    );

    await runPublishSweep(NOW);

    const update = mockPrisma.scheduledPost.update.mock.calls[0][0];
    expect(update.data.status).toBe("FAILED");
    expect(update.data.errorMessage).toMatch(/No Facebook Page/);
  });

  it("publishes a Threads video once its container is FINISHED", async () => {
    const threadsPost = {
      id: "post_th",
      platform: "THREADS",
      instagramAccountId: null,
      instagramAccount: null,
      threadsAccount: { threadsUserId: "th_1", accessToken: "thtok" },
    };
    sweepFinds([], ["post_th"]);
    mockPrisma.scheduledPost.findUnique.mockResolvedValue(
      post({ ...threadsPost, status: "PROCESSING", containerId: "thc_1" })
    );
    threads.getThreadsContainerStatus.mockResolvedValue({ status: "FINISHED" });
    threads.publishThreads.mockResolvedValue({ id: "thm_1" });
    threads.getThreadsPermalink.mockResolvedValue("https://www.threads.com/@d/post/1");

    await runPublishSweep(NOW);

    expect(threads.publishThreads).toHaveBeenCalledWith("th_1", "plain:thtok", "thc_1");
    expect(mockPrisma.scheduledPost.update).toHaveBeenCalledWith({
      where: { id: "post_th" },
      data: { status: "PUBLISHED", mediaId: "thm_1", publishedAt: NOW, errorMessage: null },
    });
  });
});

describe("deleteUploadWhenDone", () => {
  const blobUrl = "https://abc123.public.blob.vercel-storage.com/reels/clip-x1.mp4";
  beforeEach(() => vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test"));
  afterEach(() => vi.unstubAllEnvs());

  it("deletes an uploaded video once no row still needs it", async () => {
    mockPrisma.scheduledPost.count.mockResolvedValue(0);
    await deleteUploadWhenDone(blobUrl);
    expect(mockPrisma.scheduledPost.count).toHaveBeenCalledWith({
      where: { videoUrl: blobUrl, status: { notIn: ["PUBLISHED", "CANCELED"] } },
    });
    expect(mockDel).toHaveBeenCalledWith(blobUrl);
  });

  it("keeps it while another platform (or a failed row) still needs it", async () => {
    mockPrisma.scheduledPost.count.mockResolvedValue(1);
    await deleteUploadWhenDone(blobUrl);
    expect(mockDel).not.toHaveBeenCalled();
  });

  it("never touches links that are not our uploads", async () => {
    await deleteUploadWhenDone("https://cdn.example.com/reel.mp4");
    expect(mockPrisma.scheduledPost.count).not.toHaveBeenCalled();
    expect(mockDel).not.toHaveBeenCalled();
  });
});

describe("runPublishSweep: crash recovery", () => {
  it("returns stale CREATING posts to SCHEDULED and stale PUBLISHING posts to PROCESSING", async () => {
    sweepFinds([], []);

    await runPublishSweep(NOW);

    const staleBefore = new Date(NOW.getTime() - 10 * 60_000);
    expect(mockPrisma.scheduledPost.updateMany).toHaveBeenCalledWith({
      where: { status: "CREATING", updatedAt: { lt: staleBefore } },
      data: { status: "SCHEDULED" },
    });
    expect(mockPrisma.scheduledPost.updateMany).toHaveBeenCalledWith({
      where: { status: "PUBLISHING", updatedAt: { lt: staleBefore } },
      data: { status: "PROCESSING" },
    });
  });
});
