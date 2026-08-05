/**
 * Files page.
 *
 * Lists everything in public/ so a lead magnet URL can be copied straight into
 * a campaign message. The list is a build-time snapshot (see
 * tools/gen-files-manifest.mjs) because public/ is served from the CDN and is
 * not reliably readable from a serverless function at request time.
 */

import CopyLinkButton from "@/components/copy-link-button";
import { publicFiles, generatedAt } from "@/lib/files-manifest";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function FilesPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Files</h1>
        <p className="text-sm text-muted mt-1">
          Anything in your <code className="text-xs">public/</code> folder is
          served from your own domain. Copy a link and paste it into a campaign
          message.
        </p>
      </div>

      {publicFiles.length === 0 ? (
        <div className="border border-border rounded-lg p-8 text-center">
          <p className="text-sm text-foreground font-medium">No files yet</p>
          <p className="text-sm text-muted mt-2 max-w-md mx-auto">
            Add a PDF to the <code className="text-xs">public/</code> folder in
            your repo, commit, and push. It appears here after the next deploy.
          </p>
        </div>
      ) : (
        <div className="border border-border rounded-lg divide-y divide-border overflow-hidden">
          {publicFiles.map((file) => (
            <div
              key={file.urlPath}
              className="flex items-center gap-4 px-4 py-3 hover:bg-surface-hover transition-colors"
            >
              <span className="shrink-0 w-11 text-[10px] font-semibold uppercase tracking-wide text-muted">
                {file.ext || "file"}
              </span>

              <div className="min-w-0 flex-1">
                <p className="text-sm text-foreground truncate">{file.name}</p>
                <p className="text-xs text-muted truncate">
                  {file.urlPath} &middot; {formatSize(file.bytes)}
                </p>
              </div>

              <a
                href={file.urlPath}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 px-3 py-1.5 rounded text-xs font-medium border border-border text-muted hover:text-foreground hover:border-border-hover hover:bg-surface-hover transition-colors"
              >
                Open
              </a>
              <CopyLinkButton urlPath={file.urlPath} />
            </div>
          ))}
        </div>
      )}

      <div className="border border-border rounded-lg p-4 space-y-2">
        <p className="text-sm font-medium text-foreground">Adding a file</p>
        <ol className="text-sm text-muted space-y-1 list-decimal list-inside">
          <li>
            Drop it into the <code className="text-xs">public/</code> folder in
            your repo (use hyphens, no spaces).
          </li>
          <li>
            <code className="text-xs">
              git add public/ &amp;&amp; git commit -m &quot;Add file&quot;
              &amp;&amp; git push
            </code>
          </li>
          <li>Vercel redeploys in about a minute, then it shows up here.</li>
        </ol>
        <p className="text-xs text-muted pt-1">
          Anyone with the link can open these &mdash; there is no password. List
          generated {new Date(generatedAt).toLocaleString()}.
        </p>
      </div>
    </div>
  );
}
