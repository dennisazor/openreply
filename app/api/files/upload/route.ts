import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { getPublicFiles } from "@/lib/files/public-files";
import { handleUpload } from "@/lib/files/upload";

export const runtime = "nodejs";

// Browsers always send Origin on a cross-site POST. The session cookie is
// SameSite=Lax already; this is the second lock on the door.
function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === request.nextUrl.host;
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ ok: false, error: "Cross-site upload blocked." }, { status: 403 });
  }

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, error: "Sign in to upload files." }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Send the file as multipart form data." },
      { status: 400 }
    );
  }

  const file = form.get("file");
  const name = form.get("name");
  const result = await handleUpload({
    sessionEmail: session.user.email,
    file: typeof file === "string" ? null : file,
    requestedName: typeof name === "string" ? name : null,
    replace: form.get("replace") === "true",
  });

  // Best effort: other instances pick the file up within the listing's 5 s TTL.
  if (result.body.ok && result.body.status !== "unchanged") getPublicFiles()?.invalidate();

  return NextResponse.json(result.body, { status: result.status });
}
