import { describe, expect, it } from "vitest";
import nextConfig from "@/next.config";
import {
  SOURCE_HEADER,
  createPublicFiles,
  getRepoAccess,
  isServableName,
  listFilesForPage,
} from "@/lib/files/public-files";
import { UPLOAD_EXTENSIONS } from "@/lib/files/upload-rules";

const access = { token: "test-token", owner: "dennisazor", repo: "openreply", branch: "main" };
const LISTING_URL = "https://api.github.com/repos/dennisazor/openreply/contents/public?ref=main";
const BLOB_PREFIX = "https://api.github.com/repos/dennisazor/openreply/git/blobs/";

const encode = (text: string) => new TextEncoder().encode(text);
const PDF = encode("%PDF-1.4\nhello\n%%EOF\n");
const LABELED = encode("%PDF-1.4\n<< /MSIP_Label_abc-123_Name (Confidential) >>\n%%EOF\n");

type RepoFile = { sha: string; bytes: Uint8Array<ArrayBuffer>; size?: number };

function fakeGitHub(files: Record<string, RepoFile>, options: { listingStatus?: number } = {}) {
  const calls: { url: string; accept: string }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, accept: ((init?.headers ?? {}) as Record<string, string>).Accept });

    if (url === LISTING_URL) {
      if (options.listingStatus) return new Response("GitHub is down", { status: options.listingStatus });
      return Response.json([
        ...Object.entries(files).map(([name, f]) => ({
          type: "file",
          name,
          sha: f.sha,
          size: f.size ?? f.bytes.byteLength,
        })),
        { type: "dir", name: "nested", sha: "tree-sha", size: 0 },
      ]);
    }
    const match = Object.values(files).find((f) => url === BLOB_PREFIX + f.sha);
    return match ? new Response(match.bytes) : new Response("Not Found", { status: 404 });
  }) as typeof fetch;

  const listingCalls = () => calls.filter((c) => c.url === LISTING_URL).length;
  const blobCalls = () => calls.filter((c) => c.url.startsWith(BLOB_PREFIX)).length;
  return { fetchImpl, calls, listingCalls, blobCalls };
}

describe("isServableName", () => {
  it.each(["pm-or-tpm.pdf", "hype_index.pdf", "how-many-ubers-in-sf.pdf", "cover.png", "photo.jpeg", "a.webp", "b.gif"])(
    "serves %s",
    (name) => expect(isServableName(name)).toBe(true)
  );

  it.each(["Resume.pdf", "../secret.pdf", "a b.pdf", "page.html", "logo.svg", "-lead.pdf", "lead-.pdf", ".env", "x.pdf.exe", ""])(
    "refuses %s",
    (name) => expect(isServableName(name)).toBe(false)
  );
});

describe("serve", () => {
  it("serves a file that is only on GitHub, with the instant-link headers", async () => {
    const github = fakeGitHub({ "new-guide.pdf": { sha: "abc123", bytes: PDF } });
    const files = createPublicFiles(access, github.fetchImpl);

    const res = await files.serve("new-guide.pdf", "GET");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-length")).toBe(String(PDF.byteLength));
    expect(res.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=60, stale-while-revalidate=300");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get(SOURCE_HEADER)).toBe("github");
    expect(res.headers.get("etag")).toBe('"abc123"');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PDF);

    const blob = github.calls.find((c) => c.url.startsWith(BLOB_PREFIX));
    expect(blob?.accept).toBe("application/vnd.github.raw+json");
  });

  it("answers HEAD with the same headers and no body", async () => {
    const files = createPublicFiles(access, fakeGitHub({ "a.pdf": { sha: "s1", bytes: PDF } }).fetchImpl);
    const res = await files.serve("a.pdf", "HEAD");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(PDF.byteLength));
    expect(await res.text()).toBe("");
  });

  it("returns a no-store 404 for unknown names without a per-name GitHub call", async () => {
    const github = fakeGitHub({ "a.pdf": { sha: "s1", bytes: PDF } });
    const files = createPublicFiles(access, github.fetchImpl);
    const res = await files.serve("missing.pdf", "GET");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(github.listingCalls()).toBe(1);
    expect(github.blobCalls()).toBe(0);
  });

  it("never calls GitHub for names the uploader couldn't have made", async () => {
    const github = fakeGitHub({ "a.pdf": { sha: "s1", bytes: PDF } });
    const files = createPublicFiles(access, github.fetchImpl);
    for (const name of ["../.env", "Resume.pdf", "x.html", "a b.pdf"]) {
      const res = await files.serve(name, "GET");
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(github.calls).toHaveLength(0);
  });

  it("refuses a file carrying a sensitivity label", async () => {
    const files = createPublicFiles(access, fakeGitHub({ "labeled.pdf": { sha: "s2", bytes: LABELED } }).fetchImpl);
    const res = await files.serve("labeled.pdf", "GET");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("leaves files over 4 MB to the static build", async () => {
    const github = fakeGitHub({ "big.pdf": { sha: "s3", bytes: PDF, size: 5 * 1024 * 1024 } });
    const res = await createPublicFiles(access, github.fetchImpl).serve("big.pdf", "GET");
    expect(res.status).toBe(404);
    expect(github.blobCalls()).toBe(0);
  });

  it("returns a no-store 503 when GitHub fails, so the outage isn't cached", async () => {
    const files = createPublicFiles(access, fakeGitHub({}, { listingStatus: 500 }).fetchImpl);
    const res = await files.serve("a.pdf", "GET");
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("listing cache", () => {
  it("reuses the listing for 5 seconds, then refreshes", async () => {
    let t = 0;
    const github = fakeGitHub({ "a.pdf": { sha: "s1", bytes: PDF } });
    const files = createPublicFiles(access, github.fetchImpl, () => t);

    await files.serve("a.pdf", "GET");
    t = 4_999;
    await files.serve("a.pdf", "GET");
    expect(github.listingCalls()).toBe(1);

    t = 5_001;
    await files.serve("a.pdf", "GET");
    expect(github.listingCalls()).toBe(2);
    // Content is keyed by sha, so it's only downloaded once.
    expect(github.blobCalls()).toBe(1);
  });

  it("shares one listing call between concurrent requests", async () => {
    const github = fakeGitHub({ "a.pdf": { sha: "s1", bytes: PDF }, "b.pdf": { sha: "s2", bytes: PDF } });
    const files = createPublicFiles(access, github.fetchImpl);
    await Promise.all([files.serve("a.pdf", "GET"), files.serve("b.pdf", "GET"), files.serve("nope.pdf", "GET")]);
    expect(github.listingCalls()).toBe(1);
  });

  it("shows a file uploaded after the listing was cached once the listing expires", async () => {
    let t = 0;
    const repo: Record<string, RepoFile> = {};
    const github = fakeGitHub(repo);
    const files = createPublicFiles(access, github.fetchImpl, () => t);

    expect((await files.serve("new.pdf", "GET")).status).toBe(404);
    repo["new.pdf"] = { sha: "s9", bytes: PDF };
    expect((await files.serve("new.pdf", "GET")).status).toBe(404);
    t = 5_001;
    expect((await files.serve("new.pdf", "GET")).status).toBe(200);
  });

  it("re-reads immediately after invalidate()", async () => {
    const github = fakeGitHub({ "a.pdf": { sha: "s1", bytes: PDF } });
    const files = createPublicFiles(access, github.fetchImpl);
    await files.serve("a.pdf", "GET");
    files.invalidate();
    await files.serve("a.pdf", "GET");
    expect(github.listingCalls()).toBe(2);
  });
});

describe("Files page list", () => {
  const manifest = [{ name: "built.pdf", urlPath: "/built.pdf", bytes: 10, ext: "pdf", modified: "x" }];

  it("reads GitHub fresh, hides starter files and sorts by name", async () => {
    const github = fakeGitHub({
      "zeta.pdf": { sha: "z", bytes: PDF },
      "alpha.pdf": { sha: "a", bytes: PDF },
      "next.svg": { sha: "n", bytes: PDF },
      ".DS_Store": { sha: "d", bytes: PDF },
    });
    const files = createPublicFiles(access, github.fetchImpl);
    await files.serve("alpha.pdf", "GET");

    const { rows, source } = await listFilesForPage(files, manifest);
    expect(source).toBe("github");
    expect(rows).toEqual([
      { name: "alpha.pdf", urlPath: "/alpha.pdf", bytes: PDF.byteLength, ext: "pdf" },
      { name: "zeta.pdf", urlPath: "/zeta.pdf", bytes: PDF.byteLength, ext: "pdf" },
    ]);
    // The page must not reuse the serving cache: a new upload has to appear at once.
    expect(github.listingCalls()).toBe(2);
  });

  it("falls back to the build manifest when GitHub fails", async () => {
    const files = createPublicFiles(access, fakeGitHub({}, { listingStatus: 502 }).fetchImpl);
    const { rows, source } = await listFilesForPage(files, manifest);
    expect(source).toBe("build");
    expect(rows).toEqual([{ name: "built.pdf", urlPath: "/built.pdf", bytes: 10, ext: "pdf" }]);
  });

  it("falls back to the build manifest when uploads aren't configured", async () => {
    expect((await listFilesForPage(null, manifest)).source).toBe("build");
  });
});

describe("getRepoAccess", () => {
  it("needs a token and a repo, but not the upload allowlist", () => {
    expect(getRepoAccess({}).ok).toBe(false);
    expect(getRepoAccess({ GITHUB_UPLOAD_REPO: "dennisazor/openreply" }).ok).toBe(false);
    expect(getRepoAccess({ GITHUB_UPLOAD_TOKEN: "t", GITHUB_UPLOAD_REPO: "dennisazor/openreply" })).toEqual({
      ok: true,
      access: { token: "t", owner: "dennisazor", repo: "openreply", branch: "main" },
    });
    expect(
      getRepoAccess({ GITHUB_UPLOAD_TOKEN: "t", VERCEL_GIT_REPO_OWNER: "dennisazor", VERCEL_GIT_REPO_SLUG: "openreply" })
    ).toMatchObject({ ok: true, access: { owner: "dennisazor", repo: "openreply" } });
  });
});

describe("next.config rewrite", () => {
  it("sends only upload-style names to the raw route, after real files are checked", async () => {
    const rewrites = (await nextConfig.rewrites!()) as {
      beforeFiles: unknown[];
      afterFiles: { source: string; destination: string }[];
    };
    // beforeFiles would run before public/ is checked and shadow every static file.
    expect(rewrites.beforeFiles).toEqual([]);

    const raw = rewrites.afterFiles.find((r) => r.destination === "/api/files/raw/:name");
    expect(raw).toBeDefined();
    for (const ext of UPLOAD_EXTENSIONS) expect(raw!.source).toContain(ext);
  });
});
