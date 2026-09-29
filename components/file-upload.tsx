"use client";

/**
 * Upload panel for the Files page.
 *
 * An upload is a commit to public/ on GitHub followed by a Vercel rebuild, so
 * success happens in two steps. The panel only says "Live" after it has
 * downloaded the file from the live link and confirmed it matches the upload
 * byte for byte. The commit succeeding is not treated as proof that the link works.
 */

import { useEffect, useRef, useState } from "react";
import CopyLinkButton from "@/components/copy-link-button";
import {
  MAX_UPLOAD_BYTES,
  UPLOAD_ACCEPT,
  formatBytes,
  toPublicFileName,
  type UploadResponse,
} from "@/lib/files/upload-rules";

type Uploaded = Extract<UploadResponse, { ok: true }>;

type Phase =
  | { kind: "idle" }
  | { kind: "uploading" }
  | { kind: "confirm-replace"; message: string }
  | { kind: "deploying"; result: Uploaded; startedAt: number }
  | { kind: "live"; result: Uploaded }
  | { kind: "timeout"; result: Uploaded }
  | { kind: "error"; message: string };

const POLL_MS = 8_000;
const TIMEOUT_MS = 8 * 60_000;

const buttonPrimary =
  "rounded bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-50";
const buttonSecondary =
  "shrink-0 px-3 py-1.5 rounded text-xs font-medium border border-border text-muted hover:text-foreground hover:border-border-hover hover:bg-surface-hover transition-colors";

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function isLive(result: Uploaded): Promise<boolean> {
  const url = `${result.urlPath}?v=${Date.now()}`;
  try {
    const head = await fetch(url, { method: "HEAD", cache: "no-store" });
    if (!head.ok) return false;
    // Cheap check first: while an old copy is still being served, its size usually differs.
    const length = head.headers.get("content-length");
    if (length !== null && Number(length) !== result.bytes) return false;

    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return false;
    return (await sha256Hex(await res.arrayBuffer())) === result.sha256;
  } catch {
    return false;
  }
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export default function FileUpload({ existingNames }: { existingNames: string[] }) {
  const [file, setFile] = useState<File | null>(null);
  const [nameInput, setNameInput] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [elapsed, setElapsed] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);

  const target = nameInput ? toPublicFileName(nameInput) : null;
  const tooBig = file !== null && file.size > MAX_UPLOAD_BYTES;
  const nameTaken = target?.ok === true && existingNames.includes(target.name);
  const busy = phase.kind === "uploading" || phase.kind === "deploying";
  const canUpload = file !== null && target?.ok === true && !tooBig && !busy;

  function choose(next: File | null) {
    setFile(next);
    setPhase({ kind: "idle" });
    if (!next) {
      setNameInput("");
      return;
    }
    const named = toPublicFileName(next.name);
    setNameInput(named.ok ? named.name : next.name);
  }

  function reset() {
    choose(null);
    if (fileInput.current) fileInput.current.value = "";
  }

  async function upload(replace: boolean) {
    if (!file || !target?.ok) return;
    setPhase({ kind: "uploading" });

    const form = new FormData();
    form.set("file", file);
    form.set("name", target.name);
    form.set("replace", String(replace));

    let res: Response;
    try {
      res = await fetch("/api/files/upload", { method: "POST", body: form });
    } catch {
      setPhase({ kind: "error", message: "Couldn't reach the server. Check your connection and try again." });
      return;
    }

    const body = (await res.json().catch(() => null)) as UploadResponse | null;
    if (!body) {
      setPhase({ kind: "error", message: `Upload failed (HTTP ${res.status}).` });
      return;
    }
    if (!body.ok) {
      setPhase(
        body.code === "exists"
          ? { kind: "confirm-replace", message: body.error }
          : { kind: "error", message: body.error }
      );
      return;
    }
    if (body.status === "unchanged") {
      setPhase({ kind: "live", result: body });
      return;
    }
    setElapsed(0);
    setPhase({ kind: "deploying", result: body, startedAt: Date.now() });
  }

  useEffect(() => {
    if (phase.kind !== "deploying") return;
    const { result, startedAt } = phase;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function check() {
      if (cancelled) return;
      if (Date.now() - startedAt > TIMEOUT_MS) {
        setPhase({ kind: "timeout", result });
        return;
      }
      setElapsed(Date.now() - startedAt);
      const live = await isLive(result);
      if (cancelled) return;
      if (live) setPhase({ kind: "live", result });
      else timer = setTimeout(check, POLL_MS);
    }

    timer = setTimeout(check, POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [phase]);

  return (
    <div className="border border-border rounded-lg p-4 space-y-3">
      <div>
        <p className="text-sm font-medium text-foreground">Upload a file</p>
        <p className="text-xs text-muted mt-0.5">
          PDF or image, up to {formatBytes(MAX_UPLOAD_BYTES)}. The link works about 1 to 2
          minutes after you upload, once Vercel finishes redeploying.
        </p>
      </div>

      <input
        ref={fileInput}
        type="file"
        accept={UPLOAD_ACCEPT}
        disabled={busy}
        onChange={(event) => choose(event.target.files?.[0] ?? null)}
        className="block w-full text-sm text-muted file:mr-3 file:rounded file:border file:border-border file:bg-surface file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-foreground hover:file:bg-surface-hover disabled:opacity-50"
      />

      {file && (
        <div className="space-y-1.5">
          <label className="block">
            <span className="text-xs text-muted">Name on your site</span>
            <input
              value={nameInput}
              disabled={busy}
              onChange={(event) => {
                setNameInput(event.target.value);
                setPhase({ kind: "idle" });
              }}
              className="mt-1 block w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-accent focus:outline-none disabled:opacity-50"
            />
          </label>
          {target && !target.ok && <p className="text-xs text-error">{target.error}</p>}
          {target?.ok && (
            <p className="text-xs text-muted break-all">
              Link: {window.location.origin}/{target.name} &middot; {formatBytes(file.size)}
            </p>
          )}
          {tooBig && (
            <p className="text-xs text-error">
              This file is {formatBytes(file.size)}. The limit is {formatBytes(MAX_UPLOAD_BYTES)}.
            </p>
          )}
          {nameTaken && phase.kind === "idle" && (
            <p className="text-xs text-warning">
              A file with this name is already live. You&apos;ll be asked before it&apos;s replaced.
            </p>
          )}
        </div>
      )}

      <div aria-live="polite" className="space-y-2">
        {(phase.kind === "idle" || phase.kind === "uploading" || phase.kind === "error") && (
          <>
            {phase.kind === "error" && <p className="text-sm text-error">{phase.message}</p>}
            <button
              type="button"
              disabled={!canUpload}
              onClick={() => upload(false)}
              className={buttonPrimary}
            >
              {phase.kind === "uploading" ? "Uploading..." : "Upload"}
            </button>
          </>
        )}

        {phase.kind === "confirm-replace" && (
          <div className="rounded border border-warning/30 bg-warning/10 p-3 space-y-2">
            <p className="text-sm text-foreground">{phase.message}</p>
            <div className="flex gap-2">
              <button type="button" onClick={() => upload(true)} className={buttonPrimary}>
                Replace it
              </button>
              <button type="button" onClick={() => setPhase({ kind: "idle" })} className={buttonSecondary}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {phase.kind === "deploying" && (
          <div className="rounded border border-border bg-surface p-3 space-y-1">
            <p className="text-sm text-foreground">
              Saved to GitHub. Vercel is rebuilding the site.
            </p>
            <p className="text-xs text-muted">
              Checking the live link every few seconds ({formatElapsed(elapsed)} so far).{" "}
              {phase.result.commitUrl && (
                <a href={phase.result.commitUrl} target="_blank" rel="noopener noreferrer" className="underline">
                  View commit
                </a>
              )}
            </p>
          </div>
        )}

        {phase.kind === "live" && (
          <div className="rounded border border-success/30 bg-success/10 p-3 space-y-2">
            <p className="text-sm text-foreground">
              {phase.result.status === "unchanged"
                ? "This exact file is already live. Nothing changed."
                : "Live. The file at this link matches your upload byte for byte."}
            </p>
            <p className="text-xs text-muted break-all">
              {window.location.origin}
              {phase.result.urlPath}
            </p>
            <div className="flex flex-wrap gap-2">
              <CopyLinkButton urlPath={phase.result.urlPath} />
              <a
                href={phase.result.urlPath}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonSecondary}
              >
                Open
              </a>
              {phase.result.status !== "unchanged" && (
                <button type="button" onClick={() => window.location.reload()} className={buttonSecondary}>
                  Refresh list
                </button>
              )}
              <button type="button" onClick={reset} className={buttonSecondary}>
                Upload another
              </button>
            </div>
          </div>
        )}

        {phase.kind === "timeout" && (
          <div className="rounded border border-error/20 bg-error/10 p-3 space-y-2">
            <p className="text-sm text-foreground">
              Saved to GitHub, but the link still isn&apos;t serving the new file after 8 minutes.
              The Vercel build may have failed, so check the latest deployment in Vercel.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setPhase({ kind: "deploying", result: phase.result, startedAt: Date.now() })}
                className={buttonSecondary}
              >
                Keep checking
              </button>
              {phase.result.commitUrl && (
                <a
                  href={phase.result.commitUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonSecondary}
                >
                  View commit
                </a>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
