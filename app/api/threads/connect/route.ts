import { NextResponse } from "next/server";
import { getBaseUrl, getMissingThreadsOAuthEnv } from "@/lib/env";
import { createOAuthState } from "@/lib/meta/oauth";
import { getThreadsAuthorizationUrl } from "@/lib/meta/threads";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";

/** Starts "Connect Threads". */
export async function GET() {
  const context = await getCurrentWorkspaceContext();
  if (!context) return NextResponse.redirect(`${getBaseUrl()}/login`);
  if (!canManageWorkspace(context.role)) {
    return NextResponse.redirect(`${getBaseUrl()}/settings?threads=forbidden`);
  }

  const missing = getMissingThreadsOAuthEnv();
  if (missing.length > 0) {
    return NextResponse.redirect(
      `${getBaseUrl()}/settings?threads=misconfigured&missing=${encodeURIComponent(missing.join(","))}`
    );
  }

  const redirectUri = `${getBaseUrl()}/api/threads/callback`;
  return NextResponse.redirect(
    getThreadsAuthorizationUrl(redirectUri, createOAuthState(context.workspaceId))
  );
}
