"use client";

/**
 * Post composer: the side panel on the Posts page. Creates a Reel, edits a
 * scheduled one, re-queues a failed one, or shows a published one read-only.
 * The parent remounts it (via `key`) whenever the post it shows changes.
 */

import { useState } from "react";
import type { AccountOption } from "@/components/account-select";
import {
  countHashtags,
  formatWhen,
  fromInputs,
  postDate,
  statusStyle,
  toDateInput,
  toTimeInput,
  type PostRow,
} from "@/lib/publishing/calendar";

type Trial = "off" | "auto" | "manual";

interface PostComposerProps {
  post: PostRow | null;
  /** For a new post started from a calendar day. */
  day: Date | null;
  accounts: AccountOption[];
  onClose: () => void;
  onChanged: () => void;
}

const fieldClass =
  "w-full min-h-11 rounded-[10px] border border-border-hover bg-surface px-3 text-[15px] text-foreground outline-none transition-colors focus:border-accent/50 disabled:bg-surface-hover disabled:text-muted";
const labelClass = "text-[13px] font-semibold text-[#3a3a3c]";

function initialTrial(post: PostRow | null): Trial {
  if (post?.trialGraduation === "MANUAL") return "manual";
  if (post?.trialGraduation === "SS_PERFORMANCE") return "auto";
  return "off";
}

export default function PostComposer({
  post,
  day,
  accounts,
  onClose,
  onChanged,
}: PostComposerProps) {
  const status = post?.status ?? "NEW";
  const editable = status === "NEW" || status === "SCHEDULED" || status === "FAILED";
  const inFlight = ["CREATING", "PROCESSING", "PUBLISHING"].includes(status);

  // A failed post's old time is in the past; retry defaults to "now".
  const start =
    post && status !== "FAILED" ? postDate(post) : status === "NEW" && day ? day : null;
  const startHasTime = Boolean(post && status !== "FAILED");

  const [accountId, setAccountId] = useState(
    post?.instagramAccount.id ?? accounts[0]?.id ?? ""
  );
  const [videoUrl, setVideoUrl] = useState(post?.videoUrl ?? "");
  const [caption, setCaption] = useState(post?.caption ?? "");
  const [date, setDate] = useState(start ? toDateInput(start) : "");
  const [time, setTime] = useState(start && startHasTime ? toTimeInput(start) : "");
  const [trial, setTrial] = useState<Trial>(initialTrial(post));
  const [shareToFeed, setShareToFeed] = useState(post?.shareToFeed ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hashtags = countHashtags(caption);
  const captionOver = caption.length > 2200 || hashtags > 30;
  const urlInvalid = videoUrl.length >= 8 && !videoUrl.startsWith("https://");
  const urlPlayable = videoUrl.startsWith("https://") && !urlInvalid;

  const title =
    status === "NEW"
      ? "New post"
      : status === "SCHEDULED"
        ? "Edit post"
        : status === "FAILED"
          ? "Failed post"
          : status === "PUBLISHED"
            ? "Published post"
            : "Publishing";

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (Boolean(date) !== Boolean(time)) {
      setError("Pick both a date and a time, or leave both empty to post now.");
      return;
    }
    const when = fromInputs(date, time);

    setBusy(true);
    try {
      const res = await fetch(post ? `/api/posts/${post.id}` : "/api/posts", {
        method: post ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instagramAccountId: accountId || undefined,
          videoUrl: videoUrl.trim(),
          caption,
          trialReel: trial,
          shareToFeed,
          publishAt: when ? when.toISOString() : undefined,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error ?? "Could not save the post.");
        return;
      }
      onChanged();
      onClose();
    } catch {
      setError("Could not reach OpenReply. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function cancelPost() {
    if (!post) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/posts/${post.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!data.success) {
        setError(data.error ?? "Could not cancel the post.");
        return;
      }
      onChanged();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  const primaryLabel = busy
    ? "Saving..."
    : status === "FAILED"
      ? "Try again"
      : status === "SCHEDULED"
        ? "Save"
        : date
          ? "Schedule"
          : "Post now";

  return (
    <aside
      aria-label={title}
      className="settle-in w-full shrink-0 rounded-[20px] bg-surface p-5 shadow-[0_10px_36px_rgba(0,0,0,0.10),0_1px_2px_rgba(0,0,0,0.06)] lg:sticky lg:top-20 lg:w-[380px]"
    >
      <form onSubmit={save} className="flex flex-col gap-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-xl font-bold tracking-[-0.015em]">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="press inline-flex h-8 w-8 items-center justify-center rounded-full bg-surface-hover text-[#3a3a3c] hover:bg-fill"
          >
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        {status === "PUBLISHED" && post && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-success-soft px-3.5 py-3">
            <span className="text-sm font-semibold text-success">
              Published {formatWhen(postDate(post))}
            </span>
            {post.permalink && (
              <a
                href={post.permalink}
                target="_blank"
                rel="noreferrer"
                className="text-sm font-semibold text-success underline-offset-2 hover:underline"
              >
                View on Instagram
              </a>
            )}
          </div>
        )}
        {inFlight && (
          <div className="rounded-xl bg-warning-soft px-3.5 py-3 text-sm text-warning">
            <b>Publishing now.</b> Instagram is processing the video. This page
            updates when it is live.
          </div>
        )}
        {status === "FAILED" && post?.errorMessage && (
          <div className="rounded-xl bg-error-soft px-3.5 py-3 text-sm leading-snug text-error">
            <b>Failed.</b> {post.errorMessage}
          </div>
        )}

        <fieldset disabled={!editable || busy} className="flex flex-col gap-5">
          {accounts.length > 1 && (
            <label className="flex flex-col gap-1.5">
              <span className={labelClass}>Account</span>
              <select
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
                className={fieldClass}
              >
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    @{account.username}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div className="flex gap-3.5">
            <div className="flex h-40 w-[90px] shrink-0 items-center justify-center overflow-hidden rounded-xl bg-foreground">
              {urlPlayable ? (
                <video
                  key={videoUrl}
                  src={videoUrl}
                  muted
                  playsInline
                  preload="metadata"
                  className="h-full w-full object-cover"
                  aria-label="Video preview"
                />
              ) : (
                <svg aria-hidden="true" width="26" height="26" viewBox="0 0 24 24" fill="#ffffff">
                  <path d="M8 5.5v13l11-6.5z" />
                </svg>
              )}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <label htmlFor="composer-url" className={labelClass}>
                Video link
              </label>
              <input
                id="composer-url"
                type="url"
                required
                value={videoUrl}
                onChange={(event) => setVideoUrl(event.target.value)}
                placeholder="https://..."
                aria-invalid={urlInvalid}
                aria-describedby="composer-url-help"
                className={`${fieldClass} ${urlInvalid ? "border-error" : ""}`}
              />
              {urlInvalid && (
                <span className="text-[13px] text-error">
                  Use a public https:// link to the file.
                </span>
              )}
              <span id="composer-url-help" className="text-xs leading-snug text-muted">
                A direct link to an MP4 or MOV. 3 s to 15 min, under 300 MB,
                9:16 looks best.
              </span>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="composer-caption" className={labelClass}>
              Caption
            </label>
            <textarea
              id="composer-caption"
              rows={4}
              value={caption}
              onChange={(event) => setCaption(event.target.value)}
              className={`${fieldClass} min-h-0 resize-y py-2.5 leading-snug`}
            />
            <span
              className={`self-end text-xs tabular-nums ${captionOver ? "text-error" : "text-muted"}`}
            >
              {caption.length.toLocaleString()} / 2,200 · {hashtags} of 30 hashtags
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex gap-2.5">
              <label className="flex flex-1 flex-col gap-1.5">
                <span className={labelClass}>Date</span>
                <input
                  type="date"
                  value={date}
                  onChange={(event) => setDate(event.target.value)}
                  className={fieldClass}
                />
              </label>
              <label className="flex flex-1 flex-col gap-1.5">
                <span className={labelClass}>Time</span>
                <input
                  type="time"
                  value={time}
                  onChange={(event) => setTime(event.target.value)}
                  className={fieldClass}
                />
              </label>
            </div>
            {editable && (
              <span className="text-xs text-muted">
                Leave both empty to post now.
              </span>
            )}
          </div>

          <fieldset className="flex flex-col gap-2.5">
            <legend className={`${labelClass} mb-2`}>Who sees it first</legend>
            <div role="group" aria-label="Audience" className="flex rounded-xl bg-fill p-[3px]">
              {(
                [
                  ["off", "Followers"],
                  ["trial", "Trial: non-followers"],
                ] as const
              ).map(([value, label]) => {
                const active = value === "off" ? trial === "off" : trial !== "off";
                return (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={active}
                    onClick={() =>
                      setTrial(value === "off" ? "off" : trial === "off" ? "auto" : trial)
                    }
                    className={`press min-h-9 flex-1 rounded-[9px] text-sm font-semibold text-foreground ${
                      active ? "bg-surface shadow-[0_1px_3px_rgba(0,0,0,0.12)]" : ""
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            {trial !== "off" ? (
              <div className="flex flex-col gap-0.5 px-0.5">
                <label className="flex min-h-11 cursor-pointer items-start gap-2.5 pt-1.5 text-sm leading-snug">
                  <input
                    type="radio"
                    name="graduation"
                    checked={trial === "auto"}
                    onChange={() => setTrial("auto")}
                    className="mt-0.5 accent-accent"
                  />
                  <span>
                    <b>Share if it does well.</b> Instagram shows it to your
                    followers when it performs.
                  </span>
                </label>
                <label className="flex min-h-11 cursor-pointer items-start gap-2.5 pt-1.5 text-sm leading-snug">
                  <input
                    type="radio"
                    name="graduation"
                    checked={trial === "manual"}
                    onChange={() => setTrial("manual")}
                    className="mt-0.5 accent-accent"
                  />
                  <span>
                    <b>I decide.</b> You share it to followers yourself in the
                    Instagram app.
                  </span>
                </label>
              </div>
            ) : (
              <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm">
                <input
                  type="checkbox"
                  checked={shareToFeed}
                  onChange={(event) => setShareToFeed(event.target.checked)}
                  className="accent-accent"
                />
                Also show on your profile grid
              </label>
            )}
          </fieldset>
        </fieldset>

        {error && (
          <p role="alert" className="text-sm text-error">
            {error}
          </p>
        )}

        {editable && (
          <div className="flex flex-wrap items-center justify-between gap-2.5 pt-1">
            {status === "SCHEDULED" ? (
              <button
                type="button"
                onClick={() => void cancelPost()}
                disabled={busy}
                className="press min-h-11 px-1.5 text-[15px] font-medium text-error disabled:opacity-50"
              >
                Cancel post
              </button>
            ) : (
              <span />
            )}
            <button
              type="submit"
              disabled={busy || urlInvalid || captionOver}
              className="press min-h-11 rounded-full bg-accent px-6 text-[15px] font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {primaryLabel}
            </button>
          </div>
        )}

        {post && !editable && (
          <p className={`text-xs ${statusStyle(post.status).text}`}>
            {statusStyle(post.status).label} posts cannot be edited.
          </p>
        )}
      </form>
    </aside>
  );
}
