import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { getBaseUrl } from "@/lib/env";
import {
  exchangeFacebookCode,
  getLongLivedFacebookToken,
  listPagesWithInstagram,
} from "@/lib/meta/facebook";
import { encryptToken, verifyOAuthState } from "@/lib/meta/oauth";
import { canManageWorkspace } from "@/lib/workspace-access";

/**
 * Finishes "Connect with Facebook". Each Page with a linked Instagram account
 * is attached to that Instagram account in this workspace, matched by ID or,
 * since Meta does not promise the IDs agree across logins, by username. The
 * Instagram account must already be connected (it owns the DM features).
 */
export async function GET(request: NextRequest) {
  const baseUrl = getBaseUrl();
  const done = (status: string) => NextResponse.redirect(`${baseUrl}/settings?facebook=${status}`);

  if (request.nextUrl.searchParams.get("error")) return done("denied");
  const code = request.nextUrl.searchParams.get("code");
  const state = verifyOAuthState(request.nextUrl.searchParams.get("state"));
  if (!code || !state) return done("invalid");

  const session = await auth();
  if (!session?.user?.id) return NextResponse.redirect(`${baseUrl}/login`);
  const membership = await prisma.workspaceMember.findFirst({
    where: { workspaceId: state.workspaceId, userId: session.user.id },
  });
  if (!membership || !canManageWorkspace(membership.role)) return done("forbidden");

  try {
    const redirectUri = `${baseUrl}/api/facebook/callback`;
    const shortToken = await exchangeFacebookCode(code, redirectUri);
    const { accessToken: userToken, expiresIn } = await getLongLivedFacebookToken(shortToken);
    const pages = await listPagesWithInstagram(userToken);

    const accounts = await prisma.instagramAccount.findMany({
      where: { workspaceId: state.workspaceId },
      select: { id: true, instagramId: true, username: true },
    });

    let linked = 0;
    for (const page of pages) {
      const ig = page.instagram_business_account;
      if (!ig) continue;
      const account = accounts.find(
        (a) =>
          a.instagramId === ig.id ||
          (ig.username && a.username.toLowerCase() === ig.username.toLowerCase())
      );
      if (!account) continue;

      await prisma.instagramAccount.update({
        where: { id: account.id },
        data: {
          facebookPageId: page.id,
          facebookPageName: page.name,
          facebookIgUserId: ig.id,
          facebookPageToken: encryptToken(page.access_token),
          facebookUserToken: encryptToken(userToken),
          facebookUserExpiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
          facebookConnectedAt: new Date(),
        },
      });
      linked += 1;
    }

    return done(linked > 0 ? "connected" : pages.length > 0 ? "no_match" : "no_pages");
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    await prisma.operationalEvent
      .create({
        data: {
          source: "SYSTEM",
          level: "ERROR",
          workspaceId: state.workspaceId,
          message: "Facebook connection failed",
          payload: { error: message },
        },
      })
      .catch(() => undefined);
    return done("error");
  }
}
