import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";

export const runtime = "nodejs";

// Instagram's Reels limit; Threads and Facebook accept these files too.
const MAX_VIDEO_BYTES = 300 * 1024 * 1024;
// Safety net: the worker deletes an upload once every post using it is live.
const UPLOAD_TTL_DAYS = 120;

/**
 * Issues a short-lived token so the browser uploads a video straight to
 * Vercel Blob (large files never pass through this function). The resulting
 * public URL is what Instagram, Facebook and Threads fetch the video from.
 */
export async function POST(request: NextRequest) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json(
      { error: "Uploads are not set up. Connect a Vercel Blob store to this project." },
      { status: 503 }
    );
  }

  let body: HandleUploadBody;
  try {
    body = (await request.json()) as HandleUploadBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const result = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        // Only signed-in workspace members may upload, and only into reels/.
        const workspaceId = await getCurrentWorkspaceId();
        if (!workspaceId) throw new Error("Unauthorized");
        if (!pathname.startsWith("reels/")) throw new Error("Invalid upload path");
        return {
          allowedContentTypes: ["video/mp4", "video/quicktime"],
          maximumSizeInBytes: MAX_VIDEO_BYTES,
          addRandomSuffix: true,
          ttlDays: UPLOAD_TTL_DAYS,
          tokenPayload: JSON.stringify({ workspaceId }),
        };
      },
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload failed";
    return NextResponse.json({ error: message }, { status: message === "Unauthorized" ? 401 : 400 });
  }
}
