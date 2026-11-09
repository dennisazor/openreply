/**
 * Keeps Instagram Login tokens alive.
 *
 * Meta caps these tokens at 60 days and only lets a token be refreshed once it
 * is at least 24 hours old, so "never expires" means "always renewed early".
 * Renewing anything with under 50 days left keeps every token 50 to 60 days
 * from expiry: a month of missed runs still leaves weeks of slack.
 *
 * Runs from the always-on worker every few hours, and from the daily Vercel
 * cron as a backup, so neither one failing alone lets a token lapse.
 */

import { prisma } from "@/lib/db/client";
import { refreshLongLivedToken } from "@/lib/meta/client";
import { decryptToken, encryptToken } from "@/lib/meta/oauth";

const DAY_MS = 24 * 60 * 60 * 1000;
export const RENEW_WHEN_DAYS_LEFT = 50;
/** Below this, renewal has been failing for a while: Settings warns. */
export const RENEWAL_OVERDUE_DAYS_LEFT = 40;

export interface TokenRefreshResult {
  instagramAccountId: string;
  username: string;
  status: "refreshed" | "failed";
  error?: string;
}

export async function refreshExpiringInstagramTokens(
  now: Date = new Date()
): Promise<TokenRefreshResult[]> {
  const accounts = await prisma.instagramAccount.findMany({
    where: {
      accessToken: { not: "" },
      tokenExpiresAt: {
        not: null,
        lte: new Date(now.getTime() + RENEW_WHEN_DAYS_LEFT * DAY_MS),
      },
    },
    select: { id: true, workspaceId: true, username: true, accessToken: true },
  });

  const results: TokenRefreshResult[] = [];
  for (const account of accounts) {
    try {
      const { accessToken, expiresIn } = await refreshLongLivedToken(
        decryptToken(account.accessToken)
      );
      await prisma.instagramAccount.update({
        where: { id: account.id },
        data: {
          accessToken: encryptToken(accessToken),
          tokenExpiresAt: new Date(now.getTime() + expiresIn * 1000),
        },
      });
      results.push({
        instagramAccountId: account.id,
        username: account.username,
        status: "refreshed",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      await prisma.operationalEvent
        .create({
          data: {
            workspaceId: account.workspaceId,
            source: "TOKEN_REFRESH",
            level: "ERROR",
            message: `Token refresh failed for @${account.username}: ${message}`,
            payload: { instagramAccountId: account.id, username: account.username },
          },
        })
        .catch(() => undefined);
      results.push({
        instagramAccountId: account.id,
        username: account.username,
        status: "failed",
        error: message,
      });
    }
  }
  return results;
}
