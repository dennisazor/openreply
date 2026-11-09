"use client";

/**
 * Post composer: the side panel on the Posts page. Creates a post for any of
 * Instagram, the linked Facebook Page and Threads; edits a scheduled one;
 * re-queues a failed one; or shows a published one. The parent remounts it
 * (via `key`) whenever the post it shows changes.
 */

import { upload } from "@vercel/blob/client";
import { useState } from "react";
import SoundPicker, { type ChosenSound } from "@/components/posts/sound-picker";
import {
  countHashtags,
  FACEBOOK_REEL_MAX_SECONDS,
  formatWhen,
  fromInputs,
  PLATFORM_LABEL,
  PLATFORM_ORDER,
  postDate,
  statusStyle,
  THREADS_TEXT_LIMIT,
  toDateInput,
  toTimeInput,
  type Platform,
  type PostGroup,
} from "@/lib/publishing/calendar";

type Trial = "off" | "auto" | "manual";

export interface Connections {
  canManage: boolean;
  instagramAccounts: { id: string; username: string; facebookPageId: string | null; facebookPageName: string | null }[];
  threadsAccounts: { id: string; username: string }[];
  configured: { facebook: boolean; threads: boolean; uploads: boolean };
}

interface PostComposerProps {
  group: PostGroup | null;
  /** For a new post started from a calendar day. */
  day: Date | null;
  connections: Connections;
  onClose: () => void;
  onChanged: () => void;
}

const fieldClass =
  "w-full min-h-11 rounded-[10px] border border-border-hover bg-surface px-3 text-[15px] text-foreground outline-none transition-colors focus:border-accent/50 disabled:bg-surface-hover disabled:text-muted";
const labelClass = "text-[13px] font-semibold text-[#3a3a3c]";
const EDITABLE = ["SCHEDULED", "FAILED"];
const IN_FLIGHT = ["CREATING", "PROCESSING", "PUBLISHING"];

function initialTrial(group: PostGroup | null): Trial {
  const trial = group?.rows.find((r) => r.platform === "INSTAGRAM")?.trialGraduation;
  if (trial === "MANUAL") return "manual";
  if (trial === "SS_PERFORMANCE") return "auto";
  return "off";
}

export default function PostComposer({ group, day, connections, onClose, onChanged }: PostComposerProps) {
  const lead = group?.lead ?? null;
  const isNew = !group;
  const editable = isNew || group.rows.some((r) => EDITABLE.includes(r.status));
  const allFailed = Boolean(group) && group!.rows.every((r) => r.status === "FAILED");
  const anyScheduled = Boolean(group?.rows.some((r) => r.status === "SCHEDULED"));
  const inFlight = Boolean(group?.rows.some((r) => IN_FLIGHT.includes(r.status)));
  // Rows that went out (or are going out) stay ticked: they cannot be undone here.
  const locked = new Set(
    (group?.rows ?? []).filter((r) => !EDITABLE.includes(r.status)).map((r) => r.platform)
  );

  const start = lead && !allFailed ? postDate(lead) : isNew && day ? day : null;
  const startHasTime = Boolean(lead && !allFailed);

  const [accountId, setAccountId] = useState(
    lead?.instagramAccount?.id ?? connections.instagramAccounts[0]?.id ?? ""
  );
  const account = connections.instagramAccounts.find((a) => a.id === accountId) ?? null;
  const facebookReady = Boolean(account?.facebookPageId);
  const threadsAccount = connections.threadsAccounts[0] ?? null;

  const [platforms, setPlatforms] = useState<Set<Platform>>(
    () => new Set(group ? group.rows.map((r) => r.platform) : (["INSTAGRAM"] as Platform[]))
  );
  const [videoUrl, setVideoUrl] = useState(lead?.videoUrl ?? "");
  const [caption, setCaption] = useState(lead?.caption ?? "");
  const [date, setDate] = useState(start ? toDateInput(start) : "");
  const [time, setTime] = useState(start && startHasTime ? toTimeInput(start) : "");
  const [trial, setTrial] = useState<Trial>(initialTrial(group));
  const [shareToFeed, setShareToFeed] = useState(lead?.shareToFeed ?? true);
  const igRow = group?.rows.find((r) => r.platform === "INSTAGRAM");
  const [sound, setSound] = useState<ChosenSound | null>(
    igRow?.audioId
      ? {
          id: igRow.audioId,
          title: igRow.audioTitle ?? "Selected sound",
          audioVolume: igRow.audioVolume ?? 100,
          videoVolume: igRow.videoVolume ?? 100,
        }
      : null
  );
  const [durationSec, setDurationSec] = useState<number | null>(null);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const posting = (p: Platform) => platforms.has(p);
  const captionLimit = posting("THREADS") ? THREADS_TEXT_LIMIT : 2200;
  const hashtags = countHashtags(caption);
  const captionOver = caption.length > captionLimit || hashtags > 30;
  const urlInvalid = videoUrl.length >= 8 && !videoUrl.startsWith("https://");
  const urlPlayable = videoUrl.startsWith("https://") && !urlInvalid;
  const facebookTooLong =
    posting("FACEBOOK") && durationSec !== null && durationSec > FACEBOOK_REEL_MAX_SECONDS;

  function togglePlatform(platform: Platform) {
    if (locked.has(platform)) return;
    setPlatforms((current) => {
      const next = new Set(current);
      if (next.has(platform)) next.delete(platform);
      else next.add(platform);
      return next;
    });
  }

  const available: Record<Platform, { ok: boolean; label: string; hint: string | null }> = {
    INSTAGRAM: {
      ok: Boolean(account),
      label: account ? `@${account.username}` : "Not connected",
      hint: account ? null : "Connect Instagram in Settings",
    },
    FACEBOOK: {
      ok: facebookReady,
      label: account?.facebookPageName ?? "Facebook Page",
      hint: facebookReady
        ? null
        : connections.configured.facebook
          ? "Connect Facebook in Settings"
          : "Facebook is not set up on this server yet",
    },
    THREADS: {
      ok: Boolean(threadsAccount),
      label: threadsAccount ? `@${threadsAccount.username}` : "Threads",
      hint: threadsAccount
        ? null
        : connections.configured.threads
          ? "Connect Threads in Settings"
          : "Threads is not set up on this server yet",
    },
  };

  async function uploadFile(file: File) {
    setError(null);
    if (!/^video\/(mp4|quicktime)$/.test(file.type)) {
      setError("Choose an MP4 or MOV file.");
      return;
    }
    if (file.size > 300 * 1024 * 1024) {
      setError("Instagram takes files up to 300 MB.");
      return;
    }
    setUploadPct(0);
    try {
      const safeName = file.name.replace(/[^\w.-]+/g, "-").slice(-80);
      const blob = await upload(`reels/${safeName}`, file, {
        access: "public",
        handleUploadUrl: "/api/uploads",
        multipart: true,
        onUploadProgress: ({ percentage }) => setUploadPct(Math.round(percentage)),
      });
      setVideoUrl(blob.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploadPct(null);
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (platforms.size === 0) {
      setError("Pick at least one place to post.");
      return;
    }
    if (Boolean(date) !== Boolean(time)) {
      setError("Pick both a date and a time, or leave both empty to post now.");
      return;
    }
    const when = fromInputs(date, time);
    const useSound = posting("INSTAGRAM") && sound;

    setBusy(true);
    try {
      const res = await fetch(lead ? `/api/posts/${lead.id}` : "/api/posts", {
        method: lead ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instagramAccountId: accountId || undefined,
          platforms: PLATFORM_ORDER.filter((p) => platforms.has(p)).map((p) => p.toLowerCase()),
          videoUrl: videoUrl.trim(),
          caption,
          trialReel: trial,
          shareToFeed,
          audioId: useSound ? sound.id : undefined,
          audioTitle: useSound ? sound.title : undefined,
          audioVolume: useSound ? sound.audioVolume : undefined,
          videoVolume: useSound ? sound.videoVolume : undefined,
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
    if (!lead) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/posts/${lead.id}`, { method: "DELETE" });
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

  const title = isNew
    ? "New post"
    : inFlight
      ? "Publishing"
      : editable
        ? allFailed
          ? "Failed post"
          : "Edit post"
        : "Published post";

  const primaryLabel = busy
    ? "Saving..."
    : allFailed
      ? "Try again"
      : !isNew
        ? "Save"
        : date
          ? "Schedule"
          : "Post now";

  return (
    <aside
      aria-label={title}
      className="settle-in w-full shrink-0 rounded-[20px] bg-surface p-5 shadow-[0_10px_36px_rgba(0,0,0,0.10),0_1px_2px_rgba(0,0,0,0.06)] lg:sticky lg:top-20 lg:w-[400px]"
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

        {group && (
          <ul className="flex flex-col gap-1.5" aria-label="Status by platform">
            {group.rows.map((row) => {
              const style = statusStyle(row.status);
              return (
                <li key={row.id} className={`rounded-xl px-3 py-2.5 text-sm ${style.soft}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold">{PLATFORM_LABEL[row.platform]}</span>
                    <span className={`inline-flex items-center gap-1.5 font-semibold ${style.text}`}>
                      <span className={`h-2 w-2 rounded-full ${style.dot}`} />
                      {row.status === "PUBLISHED" && row.publishedAt
                        ? `Published ${formatWhen(new Date(row.publishedAt))}`
                        : style.label}
                    </span>
                  </div>
                  {row.errorMessage && row.status !== "PUBLISHED" && (
                    <p className={`mt-1 text-[13px] leading-snug ${style.text}`}>{row.errorMessage}</p>
                  )}
                  {row.permalink && (
                    <a
                      href={row.permalink}
                      target="_blank"
                      rel="noreferrer"
                      className={`mt-1 inline-block text-[13px] font-semibold underline-offset-2 hover:underline ${style.text}`}
                    >
                      View post
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <fieldset disabled={!editable || busy} className="flex flex-col gap-5">
          <fieldset className="flex flex-col gap-2">
            <legend className={`${labelClass} mb-2`}>Post to</legend>
            {connections.instagramAccounts.length > 1 && (
              <select
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
                aria-label="Instagram account"
                className={fieldClass}
              >
                {connections.instagramAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    @{a.username}
                  </option>
                ))}
              </select>
            )}
            <div className="flex flex-col gap-1.5">
              {PLATFORM_ORDER.map((platform) => {
                const info = available[platform];
                const on = posting(platform);
                return (
                  <button
                    key={platform}
                    type="button"
                    aria-pressed={on}
                    disabled={!info.ok || locked.has(platform)}
                    onClick={() => togglePlatform(platform)}
                    className={`press flex min-h-12 items-center justify-between gap-3 rounded-xl border px-3 text-left ${
                      on ? "border-accent/40 bg-accent-soft" : "border-border bg-surface"
                    } disabled:cursor-not-allowed disabled:opacity-60`}
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="text-sm font-semibold">{PLATFORM_LABEL[platform]}</span>
                      <span className="truncate text-xs text-muted">{info.hint ?? info.label}</span>
                    </span>
                    <span
                      aria-hidden="true"
                      className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${
                        on ? "border-accent bg-accent text-white" : "border-border-hover"
                      }`}
                    >
                      {on && (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M5 12.5l4.5 4.5L19 7.5" />
                        </svg>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </fieldset>

          <div className="flex gap-3.5">
            <div className="flex h-40 w-[90px] shrink-0 items-center justify-center overflow-hidden rounded-xl bg-foreground">
              {urlPlayable ? (
                <video
                  key={videoUrl}
                  src={videoUrl}
                  muted
                  playsInline
                  preload="metadata"
                  onLoadedMetadata={(event) => setDurationSec(event.currentTarget.duration || null)}
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
              <span className={labelClass}>Video</span>
              {connections.configured.uploads && (
                <label className="press inline-flex min-h-10 cursor-pointer items-center justify-center gap-2 rounded-full bg-surface-hover px-4 text-sm font-semibold hover:bg-fill has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50">
                  <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 16V4M7 9l5-5 5 5M5 20h14" />
                  </svg>
                  {uploadPct !== null ? `Uploading ${uploadPct}%` : "Upload video"}
                  <input
                    type="file"
                    accept="video/mp4,video/quicktime"
                    className="sr-only"
                    disabled={uploadPct !== null}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void uploadFile(file);
                      event.target.value = "";
                    }}
                  />
                </label>
              )}
              <input
                type="url"
                required
                value={videoUrl}
                onChange={(event) => setVideoUrl(event.target.value)}
                placeholder={connections.configured.uploads ? "or paste a link: https://..." : "https://..."}
                aria-label="Video link"
                aria-invalid={urlInvalid}
                className={`${fieldClass} ${urlInvalid ? "border-error" : ""}`}
              />
              {urlInvalid && (
                <span className="text-[13px] text-error">Use a public https:// link to the file.</span>
              )}
              {facebookTooLong && (
                <span className="text-[13px] text-error">
                  Facebook Reels run up to {FACEBOOK_REEL_MAX_SECONDS} s; this video is{" "}
                  {Math.round(durationSec!)} s.
                </span>
              )}
              <span className="text-xs leading-snug text-muted">
                MP4 or MOV, 9:16, under 300 MB. Instagram up to 15 min, Facebook 3 to 90 s.
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
            <span className={`self-end text-xs tabular-nums ${captionOver ? "text-error" : "text-muted"}`}>
              {caption.length.toLocaleString()} / {captionLimit.toLocaleString()}
              {posting("THREADS") ? " (Threads limit)" : ""} · {hashtags} of 30 hashtags
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex gap-2.5">
              <label className="flex flex-1 flex-col gap-1.5">
                <span className={labelClass}>Date</span>
                <input type="date" value={date} onChange={(event) => setDate(event.target.value)} className={fieldClass} />
              </label>
              <label className="flex flex-1 flex-col gap-1.5">
                <span className={labelClass}>Time</span>
                <input type="time" value={time} onChange={(event) => setTime(event.target.value)} className={fieldClass} />
              </label>
            </div>
            {editable && <span className="text-xs text-muted">Leave both empty to post now.</span>}
          </div>

          {posting("INSTAGRAM") && (
            <>
              <div className="flex flex-col gap-2">
                <span className={labelClass}>Sound on Instagram</span>
                {facebookReady && account ? (
                  <SoundPicker
                    instagramAccountId={account.id}
                    value={sound}
                    onChange={setSound}
                    disabled={!editable || busy}
                  />
                ) : (
                  <p className="text-xs leading-snug text-muted">
                    Adding a trending sound needs Facebook connected.{" "}
                    {connections.canManage && connections.configured.facebook && (
                      <a href="/api/facebook/connect" className="font-semibold text-accent">
                        Connect Facebook
                      </a>
                    )}
                  </p>
                )}
              </div>

              <fieldset className="flex flex-col gap-2.5">
                <legend className={`${labelClass} mb-2`}>Who sees it first on Instagram</legend>
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
                        onClick={() => setTrial(value === "off" ? "off" : trial === "off" ? "auto" : trial)}
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
                      <input type="radio" name="graduation" checked={trial === "auto"} onChange={() => setTrial("auto")} className="mt-0.5 accent-accent" />
                      <span>
                        <b>Share if it does well.</b> Instagram shows it to your followers when it performs.
                      </span>
                    </label>
                    <label className="flex min-h-11 cursor-pointer items-start gap-2.5 pt-1.5 text-sm leading-snug">
                      <input type="radio" name="graduation" checked={trial === "manual"} onChange={() => setTrial("manual")} className="mt-0.5 accent-accent" />
                      <span>
                        <b>I decide.</b> You share it to followers yourself in the Instagram app.
                      </span>
                    </label>
                  </div>
                ) : (
                  <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm">
                    <input type="checkbox" checked={shareToFeed} onChange={(event) => setShareToFeed(event.target.checked)} className="accent-accent" />
                    Also show on your profile grid
                  </label>
                )}
              </fieldset>
            </>
          )}
        </fieldset>

        {error && (
          <p role="alert" className="text-sm text-error">
            {error}
          </p>
        )}

        {editable && (
          <div className="flex flex-wrap items-center justify-between gap-2.5 pt-1">
            {anyScheduled ? (
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
              disabled={busy || urlInvalid || captionOver || facebookTooLong || uploadPct !== null}
              className="press min-h-11 rounded-full bg-accent px-6 text-[15px] font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {primaryLabel}
            </button>
          </div>
        )}
      </form>
    </aside>
  );
}
