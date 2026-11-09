/**
 * Workspace API tokens for the Claude connector (/api/mcp).
 *
 * Tokens are random 256-bit values; only their SHA-256 hash is stored, so a
 * database leak does not leak usable tokens. The plaintext is returned once,
 * at creation.
 */

import { createHash, randomBytes } from "crypto";
import { prisma } from "@/lib/db/client";

const TOKEN_PREFIX = "orp_";
const DISPLAY_PREFIX_LENGTH = 12;
// lastUsedAt is informational; don't write it on every request.
const LAST_USED_WRITE_INTERVAL_MS = 5 * 60_000;

export function hashApiToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateApiToken() {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return {
    token,
    tokenHash: hashApiToken(token),
    prefix: token.slice(0, DISPLAY_PREFIX_LENGTH),
  };
}

export async function createApiToken(input: {
  workspaceId: string;
  name: string;
  createdByUserId: string;
}) {
  const { token, tokenHash, prefix } = generateApiToken();
  const row = await prisma.apiToken.create({
    data: {
      workspaceId: input.workspaceId,
      name: input.name,
      createdByUserId: input.createdByUserId,
      tokenHash,
      prefix,
    },
    select: { id: true, name: true, prefix: true, createdAt: true },
  });
  return { ...row, token };
}

export function listApiTokens(workspaceId: string) {
  return prisma.apiToken.findMany({
    where: { workspaceId, revokedAt: null },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      prefix: true,
      createdAt: true,
      lastUsedAt: true,
    },
  });
}

export async function revokeApiToken(workspaceId: string, id: string) {
  const result = await prisma.apiToken.updateMany({
    where: { id, workspaceId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count === 1;
}

/** Resolves an `Authorization: Bearer orp_...` header to its workspace, or null. */
export async function authenticateApiToken(
  authorizationHeader: string | null
): Promise<{ workspaceId: string; tokenId: string } | null> {
  const match = authorizationHeader?.match(/^Bearer\s+(\S+)$/i);
  const token = match?.[1];
  if (!token || !token.startsWith(TOKEN_PREFIX)) return null;

  const row = await prisma.apiToken.findUnique({
    where: { tokenHash: hashApiToken(token) },
    select: { id: true, workspaceId: true, revokedAt: true, lastUsedAt: true },
  });
  if (!row || row.revokedAt) return null;

  const now = Date.now();
  if (
    !row.lastUsedAt ||
    now - row.lastUsedAt.getTime() > LAST_USED_WRITE_INTERVAL_MS
  ) {
    await prisma.apiToken
      .update({ where: { id: row.id }, data: { lastUsedAt: new Date(now) } })
      .catch(() => undefined);
  }

  return { workspaceId: row.workspaceId, tokenId: row.id };
}
