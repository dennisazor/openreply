import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getMissingFacebookOAuthEnv, getMissingThreadsOAuthEnv } from "@/lib/env";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";

export const runtime = "nodejs";

/**
 * Publishing connections for Settings and the composer: which Instagram
 * accounts have a Facebook Page linked, which Threads profiles are connected,
 * and whether each option is configured on this deployment. No tokens leave.
 */
export async function GET() {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const [instagramAccounts, threadsAccounts] = await Promise.all([
    prisma.instagramAccount.findMany({
      where: { workspaceId: context.workspaceId },
      orderBy: { connectedAt: "desc" },
      select: {
        id: true,
        username: true,
        tokenExpiresAt: true,
        facebookPageId: true,
        facebookPageName: true,
        facebookConnectedAt: true,
      },
    }),
    prisma.threadsAccount.findMany({
      where: { workspaceId: context.workspaceId },
      orderBy: { connectedAt: "desc" },
      select: { id: true, username: true, tokenExpiresAt: true, connectedAt: true },
    }),
  ]);

  return NextResponse.json({
    success: true,
    data: {
      canManage: canManageWorkspace(context.role),
      instagramAccounts,
      threadsAccounts,
      configured: {
        facebook: getMissingFacebookOAuthEnv().length === 0,
        threads: getMissingThreadsOAuthEnv().length === 0,
        uploads: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
      },
    },
  });
}

const disconnectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("facebook"), instagramAccountId: z.string().min(1) }),
  z.object({ kind: z.literal("threads"), threadsAccountId: z.string().min(1) }),
]);

/**
 * Removes a Facebook Page link (the Instagram account and its campaigns stay)
 * or a Threads profile. Scheduled posts that relied on it fail with a reason.
 */
export async function DELETE(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can change connections" },
      { status: 403 }
    );
  }

  const parsed = disconnectSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: "Invalid request" }, { status: 400 });
  }

  if (parsed.data.kind === "facebook") {
    await prisma.instagramAccount.updateMany({
      where: { id: parsed.data.instagramAccountId, workspaceId: context.workspaceId },
      data: {
        facebookPageId: null,
        facebookPageName: null,
        facebookIgUserId: null,
        facebookPageToken: null,
        facebookUserToken: null,
        facebookUserExpiresAt: null,
        facebookConnectedAt: null,
      },
    });
  } else {
    // Keep the account's post history: unlink scheduled rows first so they
    // fail with "connect Threads" instead of disappearing with the account.
    await prisma.scheduledPost.updateMany({
      where: { threadsAccountId: parsed.data.threadsAccountId, workspaceId: context.workspaceId },
      data: { threadsAccountId: null },
    });
    await prisma.threadsAccount.deleteMany({
      where: { id: parsed.data.threadsAccountId, workspaceId: context.workspaceId },
    });
  }

  return NextResponse.json({ success: true });
}
