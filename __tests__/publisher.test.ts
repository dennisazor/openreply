import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPrisma, meta } = vi.hoisted(() => {
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
  };
});

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/meta/client", () => meta);
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: (value: string) => `plain:${value}` }));

import { runPublishSweep } from "@/lib/publishing/publisher";

const NOW = new Date("2026-11-09T12:00:00Z");

function post(overrides: Record<string, unknown> = {}) {
  return {
    id: "post_1",
    workspaceId: "ws_1",
    instagramAccountId: "acc_1",
    videoUrl: "https://cdn.example.com/reel.mp4",
    caption: "hello",
    coverUrl: null,
    thumbOffsetMs: null,
    shareToFeed: true,
    trialGraduation: null,
    publishAt: NOW,
    status: "SCHEDULED",
    attempts: 1,
    containerId: null,
    updatedAt: NOW,
    instagramAccount: { instagramId: "17841400000000000", accessToken: "enc" },
    ...overrides,
  };
}

// findMany is called twice per sweep: due SCHEDULED posts, then PROCESSING posts.
function sweepFinds(due: string[], processing: string[]) {
  mockPrisma.scheduledPost.findMany
    .mockResolvedValueOnce(due.map((id) => ({ id })))
    .mockResolvedValueOnce(processing.map((id) => ({ id })));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.scheduledPost.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.operationalEvent.create.mockResolvedValue({});
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
      expect.objectContaining({ trialGraduation: "SS_PERFORMANCE", caption: "hello" })
    );
    expect(mockPrisma.scheduledPost.update).toHaveBeenCalledWith({
      where: { id: "post_1" },
      data: { status: "PROCESSING", containerId: "container_9", errorMessage: null },
    });
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
    mockPrisma.scheduledPost.findUnique.mockResolvedValue(
      post({ status: "CREATING", attempts: 1 })
    );
    meta.createReelContainer.mockRejectedValue(new Error("fetch failed"));

    await runPublishSweep(NOW);

    const update = mockPrisma.scheduledPost.update.mock.calls[0][0];
    expect(update.data.status).toBe("SCHEDULED");
    expect(update.data.publishAt.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("gives up after the attempt cap", async () => {
    sweepFinds(["post_1"], []);
    mockPrisma.scheduledPost.findUnique.mockResolvedValue(
      post({ status: "CREATING", attempts: 5 })
    );
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
      "container_9"
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
