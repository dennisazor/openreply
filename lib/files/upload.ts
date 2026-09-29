/**
 * Server side of the Files page uploader.
 *
 * Vercel serves public/ from the build, and a running deployment can't write
 * to it. An upload is therefore a commit to public/ on GitHub: Vercel sees the
 * push, rebuilds, and the file is live at /<name> about a minute later.
 */

import { createHash } from "node:crypto";
import { findSensitivityLabel } from "./sensitivity-label";
import {
  MAX_UPLOAD_BYTES,
  formatBytes,
  hasExpectedSignature,
  toPublicFileName,
  type UploadResponse,
} from "./upload-rules";

const GITHUB_API = "https://api.github.com";

export interface UploadConfig {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  allowedEmails: string[];
}

export type UploadConfigResult =
  | { ok: true; config: UploadConfig }
  | { ok: false; missing: string[] };

type Env = Record<string, string | undefined>;

export function parseAllowedEmails(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\s,;]+/)
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.includes("@"));
}

export function getUploadConfig(env: Env = process.env): UploadConfigResult {
  const missing: string[] = [];

  const token = env.GITHUB_UPLOAD_TOKEN?.trim() ?? "";
  if (!token) missing.push("GITHUB_UPLOAD_TOKEN");

  // Fail closed: with no allowlist, nobody can upload.
  const allowedEmails = parseAllowedEmails(env.UPLOAD_ALLOWED_EMAILS);
  if (allowedEmails.length === 0) missing.push("UPLOAD_ALLOWED_EMAILS");

  // Vercel exposes the connected repo at runtime; elsewhere, set it explicitly.
  const slug =
    env.GITHUB_UPLOAD_REPO?.trim() ||
    (env.VERCEL_GIT_REPO_OWNER && env.VERCEL_GIT_REPO_SLUG
      ? `${env.VERCEL_GIT_REPO_OWNER}/${env.VERCEL_GIT_REPO_SLUG}`
      : "");
  const [owner, repo, ...rest] = slug.split("/");
  if (!owner || !repo || rest.length > 0) missing.push("GITHUB_UPLOAD_REPO");

  if (missing.length > 0) return { ok: false, missing };

  return {
    ok: true,
    config: {
      token,
      owner,
      repo,
      branch: env.GITHUB_UPLOAD_BRANCH?.trim() || "main",
      allowedEmails,
    },
  };
}

export function isUploadAllowed(
  email: string | null | undefined,
  allowedEmails: string[]
): boolean {
  return !!email && allowedEmails.includes(email.trim().toLowerCase());
}

/** The id git assigns to these bytes, so an identical re-upload needs no commit. */
export function gitBlobSha(bytes: Uint8Array): string {
  return createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
}

class GitHubError extends Error {}

function contentsUrl(config: UploadConfig, path: string): string {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `${GITHUB_API}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${encodedPath}`;
}

function githubHeaders(config: UploadConfig, accept = "application/vnd.github+json") {
  return {
    Authorization: `Bearer ${config.token}`,
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "openreply-files-upload",
  };
}

async function describeGitHubFailure(res: Response, config: UploadConfig): Promise<GitHubError> {
  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  const detail = body?.message ? ` GitHub said: "${body.message}".` : "";
  const repo = `${config.owner}/${config.repo}`;

  switch (res.status) {
    case 401:
      return new GitHubError(
        "GitHub rejected GITHUB_UPLOAD_TOKEN. It may have expired or been revoked, so create a new one and update it in Vercel."
      );
    case 403:
      if (res.headers.get("x-ratelimit-remaining") === "0") {
        return new GitHubError("GitHub's rate limit was hit. Wait a few minutes and try again.");
      }
      return new GitHubError(
        `The token can't write to ${repo}. It needs Contents: Read and write on that repository.${detail}`
      );
    case 404:
      return new GitHubError(
        `GitHub couldn't find ${repo} on branch "${config.branch}" with this token. Check the token's repository access.${detail}`
      );
    case 409:
    case 422:
      return new GitHubError(`The file changed on GitHub during the upload. Try again.${detail}`);
    default:
      return new GitHubError(`GitHub returned HTTP ${res.status}.${detail}`);
  }
}

async function getExistingSha(
  config: UploadConfig,
  path: string,
  fetchImpl: typeof fetch
): Promise<string | null> {
  const res = await fetchImpl(`${contentsUrl(config, path)}?ref=${encodeURIComponent(config.branch)}`, {
    // The object media type returns the sha for files over 1 MB too.
    headers: githubHeaders(config, "application/vnd.github.object+json"),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw await describeGitHubFailure(res, config);

  const body = (await res.json()) as { type?: string; sha?: string };
  if (body.type !== "file" || !body.sha) {
    throw new GitHubError(`${path} exists on GitHub but is not a file.`);
  }
  return body.sha;
}

async function putFile(
  config: UploadConfig,
  args: { path: string; bytes: Uint8Array; sha: string | null; message: string },
  fetchImpl: typeof fetch
): Promise<string | null> {
  const res = await fetchImpl(contentsUrl(config, args.path), {
    method: "PUT",
    headers: { ...githubHeaders(config), "Content-Type": "application/json" },
    body: JSON.stringify({
      message: args.message,
      content: Buffer.from(args.bytes).toString("base64"),
      branch: config.branch,
      ...(args.sha ? { sha: args.sha } : {}),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw await describeGitHubFailure(res, config);

  const body = (await res.json().catch(() => null)) as { commit?: { html_url?: string } } | null;
  return body?.commit?.html_url ?? null;
}

export interface UploadInput {
  sessionEmail: string | null | undefined;
  file: (Blob & { name?: string }) | null;
  requestedName?: string | null;
  replace: boolean;
}

export interface UploadResult {
  status: number;
  body: UploadResponse;
}

const fail = (status: number, error: string, code?: "exists" | "labeled"): UploadResult => ({
  status,
  body: { ok: false, error, ...(code ? { code } : {}) },
});

/**
 * Every check an upload must pass, in order. The route handler only adds the
 * session lookup and same-origin check around this, so tests can drive it with
 * a fake fetch.
 */
export async function handleUpload(
  input: UploadInput,
  configResult: UploadConfigResult = getUploadConfig(),
  fetchImpl: typeof fetch = fetch
): Promise<UploadResult> {
  if (!input.sessionEmail) return fail(401, "Sign in to upload files.");

  if (!configResult.ok) {
    return fail(503, `Uploads aren't set up yet. Missing: ${configResult.missing.join(", ")}.`);
  }
  const config = configResult.config;

  if (!isUploadAllowed(input.sessionEmail, config.allowedEmails)) {
    return fail(403, "Your account isn't allowed to upload files. Its email must be listed in UPLOAD_ALLOWED_EMAILS.");
  }

  const file = input.file;
  if (!file) return fail(400, "Choose a file to upload.");
  if (file.size === 0) return fail(400, "That file is empty.");
  if (file.size > MAX_UPLOAD_BYTES) {
    return fail(413, `That file is ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_UPLOAD_BYTES)}.`);
  }

  const named = toPublicFileName(input.requestedName?.trim() || file.name || "");
  if (!named.ok) return fail(400, named.error);

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!hasExpectedSignature(named.ext, bytes)) {
    return fail(400, `This doesn't look like a real .${named.ext} file. Check that you picked the right file.`);
  }

  const label = findSensitivityLabel(bytes);
  if (label) {
    return fail(
      422,
      `This file carries a Microsoft sensitivity label ("${label}"). Publishing it would show that label and your organization's tenant ID to anyone who downloads it. Upload an unlabeled copy, such as the original export from outside OneDrive.`,
      "labeled"
    );
  }

  const path = `public/${named.name}`;
  const summary = {
    name: named.name,
    urlPath: `/${named.name}`,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };

  try {
    const existingSha = await getExistingSha(config, path, fetchImpl);

    if (existingSha === gitBlobSha(bytes)) {
      return { status: 200, body: { ok: true, status: "unchanged", commitUrl: null, ...summary } };
    }
    if (existingSha && !input.replace) {
      return fail(
        409,
        `${named.name} is already live. Replacing it changes the file for everyone who already has the link.`,
        "exists"
      );
    }

    const commitUrl = await putFile(
      config,
      {
        path,
        bytes,
        sha: existingSha,
        message: `${existingSha ? "Replace" : "Upload"} ${named.name} from the Files page`,
      },
      fetchImpl
    );

    return {
      status: existingSha ? 200 : 201,
      body: { ok: true, status: existingSha ? "replaced" : "created", commitUrl, ...summary },
    };
  } catch (error) {
    if (error instanceof GitHubError) return fail(502, error.message);
    const reason = error instanceof Error ? error.message : String(error);
    return fail(502, `Couldn't reach GitHub: ${reason}`);
  }
}
