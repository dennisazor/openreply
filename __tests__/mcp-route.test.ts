import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockPosts, mockPrisma } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPosts: {
    createScheduledPost: vi.fn(),
    listScheduledPosts: vi.fn(),
    cancelScheduledPost: vi.fn(),
  },
  mockPrisma: { instagramAccount: { findMany: vi.fn(), findFirst: vi.fn() } },
}));

vi.mock("@/lib/api-tokens", () => ({ authenticateApiToken: mockAuth }));
vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/publishing/posts", async () => {
  class SchedulePostError extends Error {}
  return { ...mockPosts, SchedulePostError, TRIAL_REEL_OPTIONS: ["off", "manual", "auto"] };
});

import { POST } from "@/app/api/mcp/route";

function rpc(method: string, params: unknown = {}, token = "Bearer orp_x") {
  return new Request("https://app.example.com/api/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: token,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockImplementation(async (header: string | null) =>
    header === "Bearer orp_x" ? { workspaceId: "ws_1", tokenId: "t1" } : null
  );
});

describe("/api/mcp", () => {
  it("rejects a request without a valid token", async () => {
    const res = await POST(rpc("tools/list", {}, "Bearer nope"));
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
  });

  it("completes the initialize handshake", async () => {
    const res = await POST(
      rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.serverInfo.name).toBe("openreply");
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it("lists the four publishing tools", async () => {
    const res = await POST(rpc("tools/list"));
    const body = await res.json();
    expect(body.result.tools.map((t: { name: string }) => t.name).sort()).toEqual([
      "cancel_scheduled_post",
      "list_instagram_accounts",
      "list_scheduled_posts",
      "schedule_instagram_reel",
    ]);
  });

  it("schedules through the token's workspace only", async () => {
    mockPosts.createScheduledPost.mockResolvedValue({
      id: "p1",
      status: "SCHEDULED",
      caption: "",
      videoUrl: "https://cdn.example.com/a.mp4",
      trialGraduation: "MANUAL",
      shareToFeed: true,
      publishAt: new Date("2026-11-10T23:00:00Z"),
      publishedAt: null,
      permalink: null,
      errorMessage: null,
      createdAt: new Date(),
      instagramAccount: { id: "acc_1", username: "dennis" },
    });

    const res = await POST(
      rpc("tools/call", {
        name: "schedule_instagram_reel",
        arguments: {
          video_url: "https://cdn.example.com/a.mp4",
          trial_reel: "manual",
          publish_at: "2026-11-10T18:00:00-05:00",
        },
      })
    );
    const body = await res.json();

    expect(mockPosts.createScheduledPost).toHaveBeenCalledWith(
      "ws_1",
      expect.objectContaining({
        videoUrl: "https://cdn.example.com/a.mp4",
        trialReel: "manual",
        publishAt: "2026-11-10T18:00:00-05:00",
      })
    );
    expect(body.result.isError).toBeUndefined();
    expect(JSON.parse(body.result.content[0].text).scheduled.trialReel).toBe("manual");
  });

  it("returns a tool error for an account outside the workspace", async () => {
    mockPrisma.instagramAccount.findFirst.mockResolvedValue(null);
    const res = await POST(
      rpc("tools/call", {
        name: "schedule_instagram_reel",
        arguments: { video_url: "https://cdn.example.com/a.mp4", account: "@someone" },
      })
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(mockPrisma.instagramAccount.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ workspaceId: "ws_1" }) })
    );
    expect(mockPosts.createScheduledPost).not.toHaveBeenCalled();
  });
});
