import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  createApiToken,
  listApiTokens,
  revokeApiToken,
} from "@/lib/api-tokens";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

export const runtime = "nodejs";

const createSchema = z.object({
  name: z.string().trim().min(1).max(60).default("Claude"),
});
const revokeSchema = z.object({ id: z.string().min(1) });

// A token can publish to the workspace's Instagram accounts, so managing
// tokens takes the same role as connecting an account.
async function requireManager() {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return {
      error: NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 }
      ),
    };
  }
  if (!canManageWorkspace(context.role)) {
    return {
      error: NextResponse.json(
        { success: false, error: "Only workspace owners and admins can manage API tokens" },
        { status: 403 }
      ),
    };
  }
  return { context };
}

export async function GET() {
  const { context, error } = await requireManager();
  if (error) return error;

  const tokens = await listApiTokens(context.workspaceId);
  return NextResponse.json({ success: true, data: tokens });
}

export async function POST(request: NextRequest) {
  const { context, error } = await requireManager();
  if (error) return error;

  const parsed = createSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "Name must be 1 to 60 characters" },
      { status: 400 }
    );
  }

  const token = await createApiToken({
    workspaceId: context.workspaceId,
    name: parsed.data.name,
    createdByUserId: context.userId,
  });
  return NextResponse.json({ success: true, data: token }, { status: 201 });
}

export async function DELETE(request: NextRequest) {
  const { context, error } = await requireManager();
  if (error) return error;

  const parsed = revokeSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "Token id is required" },
      { status: 400 }
    );
  }

  const revoked = await revokeApiToken(context.workspaceId, parsed.data.id);
  if (!revoked) {
    return NextResponse.json(
      { success: false, error: "Token not found" },
      { status: 404 }
    );
  }
  return NextResponse.json({ success: true });
}
