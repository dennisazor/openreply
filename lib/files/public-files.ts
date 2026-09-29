/**
 * Serves files that are committed to public/ on GitHub but aren't in the
 * running deployment yet, so an upload's link works within seconds instead of
 * after Vercel's next build.
 *
 * next.config.ts rewrites /<name> here, but Next.js checks real public/ files
 * first, so this only ever handles files newer than the deployment. Once a
 * build includes a file, Vercel serves it statically and this code is idle.
 */

import { findSensitivityLabel } from "./sensitivity-label";
import { repoFromEnv } from "./upload";
import { toPublicFileName, type UploadExtension } from "./upload-rules";

const GITHUB_API = "https://api.github.com";

// Uploads are capped at 4 MB and Vercel functions can't return more than 4.5 MB.
// Anything bigger waits for the static build.
const MAX_SERVE_BYTES = 4 * 1024 * 1024;
const LISTING_TTL_MS = 5_000;
const BLOB_CACHE_MAX_BYTES = 32 * 1024 * 1024;

// Same list tools/gen-files-manifest.mjs hides: Next.js starter artwork and site files.
export const HIDDEN_PUBLIC_FILES = new Set([
  "file.svg", "globe.svg", "next.svg", "vercel.svg", "window.svg",
  ".DS_Store", "favicon.ico", "robots.txt", "sitemap.xml",
]);

const CONTENT_TYPES: Record<UploadExtension, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

export const SOURCE_HEADER = "x-openreply-source";

export interface RepoAccess {
  token: string;
  owner: string;
  repo: string;
  branch: string;
}

export interface PublicEntry {
  name: string;
  sha: string;
  size: number;
}

type Env = Record<string, string | undefined>;

export function getRepoAccess(
  env: Env = process.env
): { ok: true; access: RepoAccess } | { ok: false } {
  const token = env.GITHUB_UPLOAD_TOKEN?.trim() ?? "";
  const target = repoFromEnv(env);
  if (!token || !target) return { ok: false };
  return { ok: true, access: { token, ...target } };
}

/** Only names the uploader itself could have produced: no case, path or type tricks. */
export function isServableName(name: string): boolean {
  const named = toPublicFileName(name);
  return named.ok && named.name === name;
}

function notFound(): Response {
  // no-store: a link requested just before its upload must not stay cached as missing.
  return new Response("Not found", {
    status: 404,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function unavailable(): Response {
  return new Response("File storage is unavailable. Try again in a few seconds.", {
    status: 503,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "Retry-After": "5",
    },
  });
}

class GitHubReadError extends Error {}

export interface PublicFiles {
  list(options?: { fresh?: boolean }): Promise<PublicEntry[]>;
  serve(name: string, method: "GET" | "HEAD"): Promise<Response>;
  invalidate(): void;
}

export function createPublicFiles(
  access: RepoAccess,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now
): PublicFiles {
  const repoUrl = `${GITHUB_API}/repos/${encodeURIComponent(access.owner)}/${encodeURIComponent(access.repo)}`;
  const headers = (accept: string) => ({
    Authorization: `Bearer ${access.token}`,
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "openreply-files",
  });

  let listing: { at: number; entries: Map<string, PublicEntry> } | null = null;
  let inflight: Promise<Map<string, PublicEntry>> | null = null;

  // Keyed by git blob sha, so an entry can never go stale.
  const blobs = new Map<string, { data: ArrayBuffer; label: string | null }>();
  let blobBytes = 0;

  async function fetchListing(): Promise<Map<string, PublicEntry>> {
    const res = await fetchImpl(
      `${repoUrl}/contents/public?ref=${encodeURIComponent(access.branch)}`,
      { headers: headers("application/vnd.github+json"), cache: "no-store", signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) throw new GitHubReadError(`listing HTTP ${res.status}`);

    const body = (await res.json()) as Array<{ type?: string; name?: string; sha?: string; size?: number }>;
    if (!Array.isArray(body)) throw new GitHubReadError("public/ is not a directory");

    const entries = new Map<string, PublicEntry>();
    for (const item of body) {
      if (item.type === "file" && item.name && item.sha) {
        entries.set(item.name, { name: item.name, sha: item.sha, size: item.size ?? 0 });
      }
    }
    return entries;
  }

  // One GitHub call per TTL no matter how many names are requested, which keeps
  // requests for made-up names from spending the token's rate limit.
  async function getListing(fresh: boolean): Promise<Map<string, PublicEntry>> {
    if (!fresh && listing && now() - listing.at < LISTING_TTL_MS) return listing.entries;
    if (!inflight) {
      inflight = fetchListing()
        .then((entries) => {
          listing = { at: now(), entries };
          return entries;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  }

  async function getBlob(sha: string): Promise<{ data: ArrayBuffer; label: string | null }> {
    const cached = blobs.get(sha);
    if (cached) return cached;

    const res = await fetchImpl(`${repoUrl}/git/blobs/${encodeURIComponent(sha)}`, {
      headers: headers("application/vnd.github.raw+json"),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new GitHubReadError(`blob HTTP ${res.status}`);

    const data = await res.arrayBuffer();
    const blob = { data, label: findSensitivityLabel(new Uint8Array(data)) };

    blobs.set(sha, blob);
    blobBytes += data.byteLength;
    for (const [key, value] of blobs) {
      if (blobBytes <= BLOB_CACHE_MAX_BYTES) break;
      blobs.delete(key);
      blobBytes -= value.data.byteLength;
    }
    return blob;
  }

  return {
    async list({ fresh = false } = {}) {
      const entries = await getListing(fresh);
      return [...entries.values()]
        .filter((entry) => !entry.name.startsWith(".") && !HIDDEN_PUBLIC_FILES.has(entry.name))
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    async serve(name, method) {
      if (!isServableName(name)) return notFound();

      let entry: PublicEntry | undefined;
      let blob: { data: ArrayBuffer; label: string | null };
      try {
        entry = (await getListing(false)).get(name);
        if (!entry || entry.size > MAX_SERVE_BYTES) return notFound();
        blob = await getBlob(entry.sha);
      } catch {
        return unavailable();
      }

      // Uploads already refuse labeled files; this covers anything committed by hand.
      if (blob.label) return notFound();

      const ext = name.slice(name.lastIndexOf(".") + 1) as UploadExtension;
      return new Response(method === "HEAD" ? null : blob.data, {
        status: 200,
        headers: {
          "Content-Type": CONTENT_TYPES[ext],
          "Content-Length": String(blob.data.byteLength),
          "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=300",
          ETag: `"${entry.sha}"`,
          "X-Content-Type-Options": "nosniff",
          [SOURCE_HEADER]: "github",
        },
      });
    },

    invalidate() {
      listing = null;
    },
  };
}

let shared: PublicFiles | null = null;

/** Process-wide instance for the route and the Files page; null until uploads are configured. */
export function getPublicFiles(env: Env = process.env): PublicFiles | null {
  if (shared) return shared;
  const result = getRepoAccess(env);
  if (!result.ok) return null;
  shared = createPublicFiles(result.access);
  return shared;
}

export interface FileRow {
  name: string;
  urlPath: string;
  bytes: number;
  ext: string;
}

/**
 * The Files page list. Reads GitHub live so a new upload shows up at once, and
 * falls back to the build-time manifest when GitHub can't be reached.
 */
export async function listFilesForPage(
  files: PublicFiles | null,
  manifest: ReadonlyArray<{ name: string; urlPath: string; bytes: number; ext: string }>
): Promise<{ rows: FileRow[]; source: "github" | "build" }> {
  const fromManifest = () => ({
    rows: manifest.map(({ name, urlPath, bytes, ext }) => ({ name, urlPath, bytes, ext })),
    source: "build" as const,
  });
  if (!files) return fromManifest();

  try {
    const entries = await files.list({ fresh: true });
    return {
      rows: entries.map((entry) => ({
        name: entry.name,
        urlPath: `/${entry.name}`,
        bytes: entry.size,
        ext: entry.name.includes(".") ? entry.name.slice(entry.name.lastIndexOf(".") + 1).toLowerCase() : "",
      })),
      source: "github",
    };
  } catch {
    return fromManifest();
  }
}
