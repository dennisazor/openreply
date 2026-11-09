import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { getBaseUrl } from "@/lib/env";
import { encryptToken, verifyOAuthState } from "@/lib/meta/oauth";
import {
  exchangeThreadsCode,
  getLongLivedThreadsToken,
  getThreadsProfile,
} from "@/lib/meta/threads";
import { canManageWorkspace } from "@/lib/workspace-access";

/** Finishes "Connect Threads": stores a 60-day token, renewed early by the worker. */
export async function GET(request: NextRequest) {
  const baseUrl = getBaseUrl();
  const done = (status: string) => NextResponse.redirect(`${baseUrl}/settings?threads=${status}`);

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
    const { accessToken: shortToken } = await exchangeThreadsCode(
      code,
      `${baseUrl}/api/threads/callback`
    );
    const { accessToken, expiresIn } = await getLongLivedThreadsToken(shortToken);
    const profile = await getThreadsProfile(accessToken);

    const existing = await prisma.threadsAccount.findUnique({
      where: { threadsUserId: profile.id },
      select: { workspaceId: true },
    });
    if (existing && existing.workspaceId !== state.workspaceId) return done("already_connected");

    const data = {
      workspaceId: state.workspaceId,
      username: profile.username,
      accessToken: encryptToken(accessToken),
      tokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
    };
    await prisma.threadsAccount.upsert({
      where: { threadsUserId: profile.id },
      create: { threadsUserId: profile.id, ...data },
      update: data,
    });
    return done("connected");
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    await prisma.operationalEvent
      .create({
        data: {
          source: "SYSTEM",
          level: "ERROR",
          workspaceId: state.workspaceId,
          message: "Threads connection failed",
          payload: { error: message },
        },
      })
      .catch(() => undefined);
    return done("error");
  }
}
