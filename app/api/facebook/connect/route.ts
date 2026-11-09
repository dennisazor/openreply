import { NextResponse } from "next/server";
import { getBaseUrl, getMissingFacebookOAuthEnv } from "@/lib/env";
import { getFacebookAuthorizationUrl } from "@/lib/meta/facebook";
import { createOAuthState } from "@/lib/meta/oauth";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";

/** Starts "Connect with Facebook" (Page publishing, sounds, uploads). */
export async function GET() {
  const context = await getCurrentWorkspaceContext();
  if (!context) return NextResponse.redirect(`${getBaseUrl()}/login`);
  if (!canManageWorkspace(context.role)) {
    return NextResponse.redirect(`${getBaseUrl()}/settings?facebook=forbidden`);
  }

  const missing = getMissingFacebookOAuthEnv();
  if (missing.length > 0) {
    return NextResponse.redirect(
      `${getBaseUrl()}/settings?facebook=misconfigured&missing=${encodeURIComponent(missing.join(","))}`
    );
  }

  const redirectUri = `${getBaseUrl()}/api/facebook/callback`;
  return NextResponse.redirect(
    getFacebookAuthorizationUrl(redirectUri, createOAuthState(context.workspaceId))
  );
}
