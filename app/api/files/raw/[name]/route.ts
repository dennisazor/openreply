import { getPublicFiles } from "@/lib/files/public-files";

export const runtime = "nodejs";

// Reached through the afterFiles rewrite in next.config.ts, only for files
// that are on GitHub but not in this deployment yet.

type Context = { params: Promise<{ name: string }> };

async function serve(method: "GET" | "HEAD", context: Context): Promise<Response> {
  const { name } = await context.params;
  const files = getPublicFiles();
  if (!files) {
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  return files.serve(name, method);
}

export function GET(_request: Request, context: Context) {
  return serve("GET", context);
}

// The upload panel checks with HEAD before downloading.
export function HEAD(_request: Request, context: Context) {
  return serve("HEAD", context);
}
