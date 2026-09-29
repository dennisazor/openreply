import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { findSensitivityLabel } from "@/lib/files/sensitivity-label";
import {
  getUploadConfig,
  gitBlobSha,
  handleUpload,
  isUploadAllowed,
  parseAllowedEmails,
  type UploadConfigResult,
} from "@/lib/files/upload";
import {
  MAX_UPLOAD_BYTES,
  hasExpectedSignature,
  toPublicFileName,
} from "@/lib/files/upload-rules";

const encode = (text: string) => new TextEncoder().encode(text);
const pdf = (body = "") => encode(`%PDF-1.4\n${body}\n%%EOF\n`);
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

describe("toPublicFileName", () => {
  it.each([
    ["The Role Breakdown.PDF", "the-role-breakdown.pdf"],
    ["hype_index.pdf", "hype_index.pdf"],
    ["../../app/page.pdf", "page.pdf"],
    ["C:\\fakepath\\My Guide (v2).pdf", "my-guide-v2.pdf"],
    ["Résumé.pdf", "resume.pdf"],
    ["  Cover Photo.JPG ", "cover-photo.jpg"],
  ])("%s -> %s", (input, expected) => {
    expect(toPublicFileName(input)).toMatchObject({ ok: true, name: expected });
  });

  it.each(["evil.html", "logo.svg", "template.docx", "README", ".pdf", "---.pdf", `${"a".repeat(81)}.pdf`])(
    "rejects %s",
    (input) => {
      expect(toPublicFileName(input).ok).toBe(false);
    }
  );
});

describe("hasExpectedSignature", () => {
  it("accepts real headers", () => {
    expect(hasExpectedSignature("pdf", pdf())).toBe(true);
    expect(hasExpectedSignature("pdf", concat(new Uint8Array(10), pdf()))).toBe(true);
    expect(hasExpectedSignature("png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe(true);
    expect(hasExpectedSignature("jpg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(hasExpectedSignature("gif", encode("GIF89a...."))).toBe(true);
    expect(hasExpectedSignature("webp", encode("RIFF\0\0\0\0WEBPVP8 "))).toBe(true);
  });

  it("rejects a renamed file", () => {
    expect(hasExpectedSignature("pdf", encode("<!doctype html><title>kit</title>"))).toBe(false);
    expect(hasExpectedSignature("png", pdf())).toBe(false);
  });
});

describe("findSensitivityLabel", () => {
  it("returns null for a clean PDF", () => {
    expect(findSensitivityLabel(pdf("1 0 obj << /Title (Guide) >> endobj"))).toBeNull();
  });

  it("reads the specific label from the Info dictionary, unescaping the PDF string", () => {
    const info =
      "1 0 obj << /MSIP_Label_55831d3e-97a5_Name (Confidential)" +
      " /MSIP_Label_3a99a3c3-74a3_Name (Confidential \\\\ Any User \\(No Protection\\)) >> endobj";
    expect(findSensitivityLabel(pdf(info))).toBe("Confidential \\ Any User (No Protection)");
  });

  it("reads the label from XMP metadata", () => {
    const xmp = "<msip:MSIP_Label_3a99a3c3-74a3_Name>Confidential</msip:MSIP_Label_3a99a3c3-74a3_Name>";
    expect(findSensitivityLabel(pdf(xmp))).toBe("Confidential");
  });

  it("finds a label hidden in a compressed object stream", () => {
    const hidden = deflateSync(Buffer.from("<< /MSIP_Label_abc-123_Name (Confidential) >>"));
    const bytes = concat(
      // An ordinary stream first: its "endstream" must not swallow the next stream's start.
      encode("%PDF-1.5\n3 0 obj\n<< /Length 5 >>\nstream\nBT ET\nendstream\nendobj\n"),
      encode("4 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode >>\nstream\n"),
      hidden,
      encode("\nendstream\nendobj\n%%EOF\n")
    );
    expect(findSensitivityLabel(bytes)).toBe("Confidential");
  });

  it("still flags label metadata whose name can't be read", () => {
    expect(findSensitivityLabel(pdf("<< /MSIP_Label_abc-123_Enabled (true) >>"))).toBe(
      "Microsoft sensitivity label"
    );
  });
});

describe("upload config", () => {
  it("parses and matches the allowlist case-insensitively", () => {
    const list = parseAllowedEmails(" Dennis@Example.com, other@x.io ;third@y.z, not-an-email");
    expect(list).toEqual(["dennis@example.com", "other@x.io", "third@y.z"]);
    expect(isUploadAllowed("DENNIS@example.com", list)).toBe(true);
    expect(isUploadAllowed("stranger@example.com", list)).toBe(false);
    expect(isUploadAllowed(null, list)).toBe(false);
    expect(isUploadAllowed("dennis@example.com", [])).toBe(false);
  });

  it("reports every missing setting", () => {
    expect(getUploadConfig({})).toEqual({
      ok: false,
      missing: ["GITHUB_UPLOAD_TOKEN", "UPLOAD_ALLOWED_EMAILS", "GITHUB_UPLOAD_REPO"],
    });
    expect(
      getUploadConfig({ GITHUB_UPLOAD_TOKEN: "t", UPLOAD_ALLOWED_EMAILS: "a@b.c", GITHUB_UPLOAD_REPO: "no-owner" })
    ).toEqual({ ok: false, missing: ["GITHUB_UPLOAD_REPO"] });
  });

  it("uses the repo Vercel exposes, and explicit overrides win", () => {
    const vercel = getUploadConfig({
      GITHUB_UPLOAD_TOKEN: "t",
      UPLOAD_ALLOWED_EMAILS: "a@b.c",
      VERCEL_GIT_REPO_OWNER: "dennisazor",
      VERCEL_GIT_REPO_SLUG: "openreply",
    });
    expect(vercel).toMatchObject({ ok: true, config: { owner: "dennisazor", repo: "openreply", branch: "main" } });

    const explicit = getUploadConfig({
      GITHUB_UPLOAD_TOKEN: "t",
      UPLOAD_ALLOWED_EMAILS: "a@b.c",
      VERCEL_GIT_REPO_OWNER: "dennisazor",
      VERCEL_GIT_REPO_SLUG: "openreply",
      GITHUB_UPLOAD_REPO: "someone/else",
      GITHUB_UPLOAD_BRANCH: "files",
    });
    expect(explicit).toMatchObject({ ok: true, config: { owner: "someone", repo: "else", branch: "files" } });
  });
});

describe("gitBlobSha", () => {
  it("matches git hash-object", () => {
    // printf 'hello\n' | git hash-object --stdin
    expect(gitBlobSha(encode("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });
});

describe("handleUpload", () => {
  const config: UploadConfigResult = {
    ok: true,
    config: {
      token: "test-token",
      owner: "dennisazor",
      repo: "openreply",
      branch: "main",
      allowedEmails: ["owner@example.com"],
    },
  };

  interface Call {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: { message: string; content: string; branch: string; sha?: string };
  }

  function fakeGitHub(options: { existingSha?: string; putStatus?: number; putMessage?: string } = {}) {
    const calls: Call[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({
        method,
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (method === "GET") {
        return options.existingSha
          ? Response.json({ type: "file", sha: options.existingSha })
          : Response.json({ message: "Not Found" }, { status: 404 });
      }
      const status = options.putStatus ?? 201;
      return status < 300
        ? Response.json({ commit: { html_url: "https://github.com/dennisazor/openreply/commit/abc" } }, { status })
        : Response.json({ message: options.putMessage ?? "nope" }, { status });
    }) as typeof fetch;
    return { fetchImpl, calls };
  }

  const upload = (
    file: File | null,
    options: { email?: string | null; name?: string; replace?: boolean; cfg?: UploadConfigResult } = {},
    fetchImpl: typeof fetch = fakeGitHub().fetchImpl
  ) =>
    handleUpload(
      {
        sessionEmail: options.email === undefined ? "Owner@Example.com" : options.email,
        file,
        requestedName: options.name ?? null,
        replace: options.replace ?? false,
      },
      options.cfg ?? config,
      fetchImpl
    );

  const guide = () => new File([pdf("guide")], "Guide.pdf");

  it("refuses without a session, config or allowlisted email, before touching GitHub", async () => {
    const github = fakeGitHub();
    expect((await upload(guide(), { email: null }, github.fetchImpl)).status).toBe(401);
    expect((await upload(guide(), { cfg: getUploadConfig({}) }, github.fetchImpl)).status).toBe(503);
    expect((await upload(guide(), { email: "stranger@example.com" }, github.fetchImpl)).status).toBe(403);
    expect(github.calls).toHaveLength(0);
  });

  it("rejects empty, oversized, disallowed and disguised files", async () => {
    expect((await upload(new File([], "empty.pdf"))).status).toBe(400);
    expect((await upload(new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], "big.pdf"))).status).toBe(413);
    expect((await upload(new File([pdf()], "page.html"))).status).toBe(400);
    expect((await upload(new File([encode("<html></html>")], "fake.pdf"))).status).toBe(400);
  });

  it("refuses a PDF carrying a sensitivity label", async () => {
    const github = fakeGitHub();
    const labeled = new File([pdf("<< /MSIP_Label_abc-123_Name (Confidential) >>")], "guide.pdf");
    const result = await upload(labeled, {}, github.fetchImpl);
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ ok: false, code: "labeled" });
    expect(github.calls).toHaveLength(0);
  });

  it("commits a new file to public/ on the configured branch", async () => {
    const github = fakeGitHub();
    const bytes = pdf("guide");
    const result = await upload(new File([bytes], "My Guide.pdf"), {}, github.fetchImpl);

    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ ok: true, status: "created", name: "my-guide.pdf", urlPath: "/my-guide.pdf" });

    const put = github.calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe("https://api.github.com/repos/dennisazor/openreply/contents/public/my-guide.pdf");
    expect(put.headers.Authorization).toBe("Bearer test-token");
    expect(put.body).toMatchObject({ branch: "main", message: "Upload my-guide.pdf from the Files page" });
    expect(put.body?.sha).toBeUndefined();
    expect(new Uint8Array(Buffer.from(put.body!.content, "base64"))).toEqual(bytes);
  });

  it("uses the requested name instead of the original file name", async () => {
    const github = fakeGitHub();
    const result = await upload(guide(), { name: "the-role-breakdown.pdf" }, github.fetchImpl);
    expect(result.body).toMatchObject({ ok: true, name: "the-role-breakdown.pdf" });
    expect(github.calls.find((c) => c.method === "PUT")!.url).toMatch(/\/public\/the-role-breakdown\.pdf$/);
  });

  it("asks before replacing, then replaces with the existing sha", async () => {
    const asked = fakeGitHub({ existingSha: "old-sha" });
    const first = await upload(guide(), {}, asked.fetchImpl);
    expect(first.status).toBe(409);
    expect(first.body).toMatchObject({ ok: false, code: "exists" });
    expect(asked.calls.some((c) => c.method === "PUT")).toBe(false);

    const confirmed = fakeGitHub({ existingSha: "old-sha" });
    const second = await upload(guide(), { replace: true }, confirmed.fetchImpl);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ ok: true, status: "replaced" });
    expect(confirmed.calls.find((c) => c.method === "PUT")!.body).toMatchObject({
      sha: "old-sha",
      message: "Replace guide.pdf from the Files page",
    });
  });

  it("skips the commit when the identical file is already there", async () => {
    const bytes = pdf("guide");
    const github = fakeGitHub({ existingSha: gitBlobSha(bytes) });
    const result = await upload(new File([bytes], "guide.pdf"), {}, github.fetchImpl);
    expect(result.body).toMatchObject({ ok: true, status: "unchanged", commitUrl: null });
    expect(github.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("explains GitHub token and permission failures", async () => {
    const expired = await upload(guide(), {}, fakeGitHub({ putStatus: 401 }).fetchImpl);
    expect(expired.status).toBe(502);
    expect(expired.body).toMatchObject({ ok: false, error: expect.stringContaining("rejected GITHUB_UPLOAD_TOKEN") });

    const readOnly = await upload(
      guide(),
      {},
      fakeGitHub({ putStatus: 403, putMessage: "Resource not accessible by personal access token" }).fetchImpl
    );
    expect(readOnly.body).toMatchObject({
      ok: false,
      error: expect.stringContaining("can't write to dennisazor/openreply"),
    });

    const offline = await upload(guide(), {}, (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch);
    expect(offline.body).toMatchObject({ ok: false, error: expect.stringContaining("Couldn't reach GitHub") });
  });
});
