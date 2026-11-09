import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import {
  cancelScheduledPost,
  SchedulePostError,
  updateScheduledPost,
} from "@/lib/publishing/posts";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

function unauthorized() {
  return NextResponse.json(
    { success: false, error: "Unauthorized" },
    { status: 401 }
  );
}

/** Edits a SCHEDULED post, or re-queues a FAILED one. Takes the full post. */
export async function PATCH(request: NextRequest, { params }: Context) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) return unauthorized();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const { id } = await params;
  try {
    const post = await updateScheduledPost(
      workspaceId,
      id,
      body as Parameters<typeof updateScheduledPost>[2]
    );
    return NextResponse.json({ success: true, data: post });
  } catch (error) {
    if (error instanceof SchedulePostError) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 400 }
      );
    }
    throw error;
  }
}

/** Cancels a post that is still SCHEDULED. */
export async function DELETE(_request: NextRequest, { params }: Context) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) return unauthorized();

  const { id } = await params;
  const canceled = await cancelScheduledPost(workspaceId, id);
  if (!canceled) {
    return NextResponse.json(
      {
        success: false,
        error: "Only a post that has not started publishing can be canceled.",
      },
      { status: 409 }
    );
  }

  return NextResponse.json({ success: true });
}
