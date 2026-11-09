import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPrisma, mockRefresh } = vi.hoisted(() => ({
  mockPrisma: {
    instagramAccount: { findMany: vi.fn(), update: vi.fn() },
    operationalEvent: { create: vi.fn() },
  },
  mockRefresh: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/meta/client", () => ({ refreshLongLivedToken: mockRefresh }));
vi.mock("@/lib/meta/oauth", () => ({
  decryptToken: (v: string) => `plain:${v}`,
  encryptToken: (v: string) => `enc:${v}`,
}));

import { refreshExpiringInstagramTokens } from "@/lib/meta/token-refresh";

const NOW = new Date("2026-11-09T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.operationalEvent.create.mockResolvedValue({});
});

describe("refreshExpiringInstagramTokens", () => {
  it("renews anything with under 50 days left, so tokens stay 50 to 60 days out", async () => {
    mockPrisma.instagramAccount.findMany.mockResolvedValue([
      { id: "a1", workspaceId: "w", username: "dennisthinks_", accessToken: "t1" },
    ]);
    mockRefresh.mockResolvedValue({ accessToken: "t2", expiresIn: 60 * 24 * 60 * 60 });

    const results = await refreshExpiringInstagramTokens(NOW);

    const where = mockPrisma.instagramAccount.findMany.mock.calls[0][0].where;
    expect(where.tokenExpiresAt.lte.getTime()).toBe(NOW.getTime() + 50 * DAY);
    expect(mockRefresh).toHaveBeenCalledWith("plain:t1");
    expect(mockPrisma.instagramAccount.update).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: { accessToken: "enc:t2", tokenExpiresAt: new Date(NOW.getTime() + 60 * DAY) },
    });
    expect(results).toEqual([
      { instagramAccountId: "a1", username: "dennisthinks_", status: "refreshed" },
    ]);
  });

  it("records a failure and keeps going", async () => {
    mockPrisma.instagramAccount.findMany.mockResolvedValue([
      { id: "a1", workspaceId: "w", username: "one", accessToken: "t1" },
      { id: "a2", workspaceId: "w", username: "two", accessToken: "t2" },
    ]);
    mockRefresh
      .mockRejectedValueOnce(new Error("Session has expired"))
      .mockResolvedValueOnce({ accessToken: "n2", expiresIn: 5184000 });

    const results = await refreshExpiringInstagramTokens(NOW);

    expect(results.map((r) => r.status)).toEqual(["failed", "refreshed"]);
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledTimes(1);
  });
});
