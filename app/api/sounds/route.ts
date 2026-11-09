import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { findSounds, SoundsUnavailableError } from "@/lib/publishing/sounds";

export const runtime = "nodejs";

/** Sounds for the composer: trending when there is no `q`. */
export async function GET(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  try {
    const sounds = await findSounds(workspaceId, {
      type: params.get("type") === "original_sound" ? "original_sound" : "music",
      query: params.get("q") ?? undefined,
      instagramAccountId: params.get("instagramAccountId"),
    });
    return NextResponse.json({ success: true, data: sounds });
  } catch (error) {
    if (error instanceof SoundsUnavailableError) {
      return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    }
    throw error;
  }
}
