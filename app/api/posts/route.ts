import { NextRequest, NextResponse } from "next/server";
import type { ScheduledPostStatus } from "@/app/generated/prisma/client";
import { getCurrentWorkspaceId } from "@/lib/auth";
import {
  createScheduledPost,
  listScheduledPosts,
  SchedulePostError,
} from "@/lib/publishing/posts";

export const runtime = "nodejs";

const STATUSES = new Set<string>([
  "SCHEDULED",
  "CREATING",
  "PROCESSING",
  "PUBLISHING",
  "PUBLISHED",
  "FAILED",
  "CANCELED",
]);

function unauthorized() {
  return NextResponse.json(
    { success: false, error: "Unauthorized" },
    { status: 401 }
  );
}

export async function GET(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) return unauthorized();

  const status = request.nextUrl.searchParams.get("status");
  const limit = Number.parseInt(request.nextUrl.searchParams.get("limit") ?? "", 10);
  const posts = await listScheduledPosts(workspaceId, {
    status:
      status && STATUSES.has(status) ? (status as ScheduledPostStatus) : undefined,
    limit: Number.isFinite(limit) ? limit : undefined,
  });

  return NextResponse.json({ success: true, data: posts });
}

export async function POST(request: NextRequest) {
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

  try {
    const post = await createScheduledPost(
      workspaceId,
      body as Parameters<typeof createScheduledPost>[1]
    );
    return NextResponse.json({ success: true, data: post }, { status: 201 });
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
