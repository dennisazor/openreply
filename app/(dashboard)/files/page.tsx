/**
 * Files page.
 *
 * Lists everything in public/ so a lead magnet URL can be copied straight into
 * a campaign message. The list is a build-time snapshot (see
 * tools/gen-files-manifest.mjs) because public/ is served from the CDN and is
 * not reliably readable from a serverless function at request time. Uploads go
 * through /api/files/upload, which commits to public/ and triggers a rebuild.
 */

import CopyLinkButton from "@/components/copy-link-button";
import FileUpload from "@/components/file-upload";
import { auth } from "@/lib/auth";
import { getUploadConfig, isUploadAllowed } from "@/lib/files/upload";
import { formatBytes } from "@/lib/files/upload-rules";
import { publicFiles, generatedAt } from "@/lib/files-manifest";

export default async function FilesPage() {
  const session = await auth();
  const upload = getUploadConfig();
  const canUpload =
    upload.ok && isUploadAllowed(session?.user?.email, upload.config.allowedEmails);

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

      {canUpload ? (
        <FileUpload existingNames={publicFiles.map((file) => file.name)} />
      ) : (
        <div className="border border-dashed border-border rounded-lg p-4">
          <p className="text-sm font-medium text-foreground">Uploads are off</p>
          <p className="text-sm text-muted mt-1">
            {upload.ok ? (
              <>
                Your account isn&apos;t allowed to upload. Add its email to{" "}
                <code className="text-xs">UPLOAD_ALLOWED_EMAILS</code> in Vercel, then
                redeploy.
              </>
            ) : (
              <>
                To upload from this page, set{" "}
                <code className="text-xs">{upload.missing.join(", ")}</code> in your
                Vercel project&apos;s environment variables, then redeploy. See{" "}
                <code className="text-xs">.env.example</code>.
              </>
            )}
          </p>
        </div>
      )}

      {publicFiles.length === 0 ? (
        <div className="border border-border rounded-lg p-8 text-center">
          <p className="text-sm text-foreground font-medium">No files yet</p>
          <p className="text-sm text-muted mt-2 max-w-md mx-auto">
            Upload one above, or commit it to the{" "}
            <code className="text-xs">public/</code> folder in your repo. It
            appears here after the next deploy.
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
                  {file.urlPath} &middot; {formatBytes(file.bytes)}
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
        <p className="text-sm font-medium text-foreground">How files get here</p>
        <ol className="text-sm text-muted space-y-1 list-decimal list-inside">
          <li>
            Upload saves the file to <code className="text-xs">public/</code> in
            your GitHub repo.
          </li>
          <li>Vercel sees the change and redeploys, which takes about a minute.</li>
          <li>
            The file is then live at its link. Committing to{" "}
            <code className="text-xs">public/</code> yourself works too.
          </li>
        </ol>
        <p className="text-xs text-muted pt-1">
          Anyone with the link can open these, because there is no password. Files
          are also stored in your GitHub repo, so if the repo is public they can be
          seen there too. List generated {new Date(generatedAt).toLocaleString()}.
        </p>
      </div>
    </div>
  );
}
