/**
 * Rules shared by the Files page uploader (browser) and the upload API route
 * (server). The server re-checks everything; the browser uses the same rules
 * so the final link and any problem show up before anything is sent.
 */

// Vercel rejects function request bodies over 4.5 MB, multipart overhead included.
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

// No SVG or HTML: both can run script on this domain. No Office files: their
// sensitivity labels sit inside a zip archive, which the label check does not open.
export const UPLOAD_EXTENSIONS = ["pdf", "png", "jpg", "jpeg", "webp", "gif"] as const;
export type UploadExtension = (typeof UPLOAD_EXTENSIONS)[number];

export const UPLOAD_ACCEPT = UPLOAD_EXTENSIONS.map((ext) => `.${ext}`).join(",");

const MAX_STEM_LENGTH = 80;

export type FileNameResult =
  | { ok: true; name: string; ext: UploadExtension }
  | { ok: false; error: string };

export type UploadResponse =
  | {
      ok: true;
      status: "created" | "replaced" | "unchanged";
      name: string;
      urlPath: string;
      bytes: number;
      sha256: string;
      commitUrl: string | null;
    }
  | { ok: false; error: string; code?: "exists" | "labeled" };

function isUploadExtension(ext: string): ext is UploadExtension {
  return (UPLOAD_EXTENSIONS as readonly string[]).includes(ext);
}

/**
 * Turns a user-supplied file name into a safe public/ file name: lowercase,
 * hyphens for spaces, nothing that could escape the folder. Underscores are
 * kept so an existing name like hype_index.pdf can still be replaced.
 */
export function toPublicFileName(input: string): FileNameResult {
  const base = (input.split(/[\\/]/).pop() ?? "").trim();
  const dot = base.lastIndexOf(".");
  if (dot < 0 || dot === base.length - 1) {
    return { ok: false, error: "The name needs a file extension, like .pdf" };
  }

  const ext = base.slice(dot + 1).toLowerCase();
  if (!isUploadExtension(ext)) {
    return {
      ok: false,
      error: `.${ext} files can't be uploaded. Allowed: ${UPLOAD_EXTENSIONS.join(", ")}`,
    };
  }

  const stem = base
    .slice(0, dot)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");

  if (!stem) {
    return { ok: false, error: "The name needs at least one letter or number" };
  }
  if (stem.length > MAX_STEM_LENGTH) {
    return { ok: false, error: `Keep the name under ${MAX_STEM_LENGTH} characters` };
  }

  return { ok: true, name: `${stem}.${ext}`, ext };
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((value, i) => bytes[offset + i] === value);
}

const ascii = (text: string) => Array.from(text, (ch) => ch.charCodeAt(0));

/**
 * Checks the file's first bytes, so a renamed file (say, an HTML export saved
 * as .pdf) is caught before it goes live under the wrong type.
 */
export function hasExpectedSignature(ext: UploadExtension, bytes: Uint8Array): boolean {
  switch (ext) {
    case "pdf": {
      // The PDF spec allows up to 1024 bytes of junk before the header.
      const head = bytes.subarray(0, 1024);
      const marker = ascii("%PDF-");
      for (let i = 0; i + marker.length <= head.length; i++) {
        if (startsWith(head, marker, i)) return true;
      }
      return false;
    }
    case "png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "jpg":
    case "jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case "gif":
      return startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"));
    case "webp":
      return startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8);
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
