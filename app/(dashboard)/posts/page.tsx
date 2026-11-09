"use client";

/**
 * Posts Page
 *
 * A week or month calendar of scheduled, publishing, published and failed
 * Reels, with the composer beside it. The worker does the publishing; this
 * page queues, edits and cancels.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AccountOption } from "@/components/account-select";
import { MonthView, TrialBadge, WeekView } from "@/components/posts/calendar-views";
import PostComposer from "@/components/posts/post-composer";
import {
  addDays,
  formatRange,
  monthGrid,
  POST_STATUS_STYLE,
  weekDays,
  type PostRow,
} from "@/lib/publishing/calendar";

type View = "week" | "month";

type ComposerState =
  | { open: false }
  | { open: true; post: PostRow | null; day: Date | null; key: string };

const IN_FLIGHT = ["SCHEDULED", "CREATING", "PROCESSING", "PUBLISHING"];

const LEGEND = ["SCHEDULED", "PROCESSING", "PUBLISHED", "FAILED"].map(
  (status) => POST_STATUS_STYLE[status]
);

function fetchPosts(): Promise<PostRow[] | null> {
  return fetch("/api/posts?limit=200")
    .then((res) => res.json())
    .then((data) => (data.success ? (data.data as PostRow[]) : null));
}

export default function PostsPage() {
  const [posts, setPosts] = useState<PostRow[]>([]);
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>("week");
  const [anchor, setAnchor] = useState(() => new Date());
  const [composer, setComposer] = useState<ComposerState>({ open: false });
  const today = useMemo(() => new Date(), []);

  const refresh = useCallback(() => {
    void fetchPosts().then((rows) => {
      if (rows) setPosts(rows);
    });
  }, []);

  useEffect(() => {
    Promise.all([
      fetchPosts(),
      fetch("/api/instagram/accounts").then((res) => res.json()),
    ])
      .then(([rows, accountData]) => {
        if (rows) setPosts(rows);
        if (accountData.success) setAccounts(accountData.data.instagramAccounts);
      })
      .finally(() => setLoading(false));
  }, []);

  // Keep statuses moving on screen while anything is queued or publishing.
  const hasInFlight = posts.some((post) => IN_FLIGHT.includes(post.status));
  useEffect(() => {
    if (!hasInFlight) return;
    const timer = setInterval(refresh, 30_000);
    return () => clearInterval(timer);
  }, [hasInFlight, refresh]);

  const days = view === "week" ? weekDays(anchor) : monthGrid(anchor);
  const rangeLabel =
    view === "week"
      ? formatRange(days)
      : anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  function step(direction: 1 | -1) {
    setAnchor((current) =>
      view === "week"
        ? addDays(current, 7 * direction)
        : new Date(current.getFullYear(), current.getMonth() + direction, 1)
    );
  }

  function openPost(post: PostRow) {
    setComposer({ open: true, post, day: null, key: post.id });
  }

  function openNew(day: Date | null) {
    setComposer({
      open: true,
      post: null,
      day,
      key: `new-${day?.toISOString() ?? "now"}-${Date.now()}`,
    });
  }

  const selectedId = composer.open ? (composer.post?.id ?? null) : null;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-[13px] font-semibold text-muted">{rangeLabel}</span>
          <h1 className="title-large">Posts</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => step(-1)}
              aria-label={view === "week" ? "Previous week" : "Previous month"}
              className="press inline-flex h-10 w-10 items-center justify-center rounded-full hover:bg-fill"
            >
              <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 5l-7 7 7 7" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => setAnchor(new Date())}
              className="press min-h-10 rounded-full bg-fill px-3.5 text-sm font-medium hover:bg-border"
            >
              Today
            </button>
            <button
              type="button"
              onClick={() => step(1)}
              aria-label={view === "week" ? "Next week" : "Next month"}
              className="press inline-flex h-10 w-10 items-center justify-center rounded-full hover:bg-fill"
            >
              <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>

          <div role="group" aria-label="View" className="inline-flex rounded-xl bg-fill p-[3px]">
            {(["week", "month"] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={view === option}
                onClick={() => setView(option)}
                className={`press min-h-[34px] rounded-[9px] px-4 text-sm font-semibold capitalize ${
                  view === option ? "bg-surface shadow-[0_1px_3px_rgba(0,0,0,0.12)]" : ""
                }`}
              >
                {option}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => openNew(null)}
            disabled={accounts.length === 0}
            className="press inline-flex min-h-11 items-center gap-2 rounded-full bg-accent px-[18px] text-[15px] font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
          >
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
            New post
          </button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-4 text-[13px] text-[#3a3a3c]">
        {LEGEND.map((style) => (
          <span key={style.label} className="inline-flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${style.dot}`} />
            {style.label}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <TrialBadge />
          Trial reel
        </span>
      </div>

      {!loading && accounts.length === 0 && (
        <div className="panel flex flex-wrap items-center justify-between gap-3 p-5">
          <p className="text-[15px]">Connect Instagram to start scheduling Reels.</p>
          <a
            href="/api/instagram/connect"
            className="press inline-flex min-h-11 items-center rounded-full bg-accent px-5 text-[15px] font-semibold text-white hover:bg-accent-hover"
          >
            Connect Instagram
          </a>
        </div>
      )}

      <div className="flex flex-col items-start gap-5 lg:flex-row">
        <div className="w-full min-w-0 flex-1">
          {loading ? (
            <div className="panel h-[520px]" />
          ) : view === "week" ? (
            <WeekView
              days={days}
              posts={posts}
              today={today}
              selectedId={selectedId}
              onPick={openPost}
              onAdd={openNew}
            />
          ) : (
            <MonthView
              days={days}
              month={anchor.getMonth()}
              posts={posts}
              today={today}
              selectedId={selectedId}
              onPick={openPost}
              onAdd={openNew}
            />
          )}
        </div>

        {composer.open && (
          <PostComposer
            key={composer.key}
            post={composer.post}
            day={composer.day}
            accounts={accounts}
            onClose={() => setComposer({ open: false })}
            onChanged={refresh}
          />
        )}
      </div>
    </div>
  );
}
