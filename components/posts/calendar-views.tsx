"use client";

/**
 * Week and month views for the Posts page. Every post and every "add" target
 * is a real button, so the calendar works from the keyboard.
 */

import {
  DAY_NAMES,
  formatTime,
  postDate,
  postsOnDay,
  sameDay,
  statusStyle,
  type PostRow,
} from "@/lib/publishing/calendar";

interface ViewProps {
  posts: PostRow[];
  today: Date;
  selectedId: string | null;
  onPick: (post: PostRow) => void;
  onAdd: (day: Date) => void;
}

function postTitle(post: PostRow) {
  const firstLine = post.caption.split("\n")[0].trim();
  return firstLine || "Untitled reel";
}

function PlayTile({ className }: { className: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center justify-center rounded-md bg-foreground ${className}`}>
      <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="#ffffff">
        <path d="M8 5.5v13l11-6.5z" />
      </svg>
    </span>
  );
}

export function TrialBadge() {
  return (
    <span className="rounded px-[5px] py-0.5 text-[10px] font-bold leading-none tracking-wide text-white bg-foreground">
      TRIAL
    </span>
  );
}

export function WeekView({ days, posts, today, selectedId, onPick, onAdd }: ViewProps & { days: Date[] }) {
  return (
    <div className="overflow-x-auto pb-1">
      <div className="grid min-w-[840px] grid-cols-7 gap-2.5">
        {days.map((day, index) => {
          const isToday = sameDay(day, today);
          const dayPosts = postsOnDay(posts, day);
          const isPast = day < today && !isToday;
          return (
            <section
              key={day.toISOString()}
              aria-label={day.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
              className={`flex min-h-[520px] flex-col gap-2 rounded-2xl px-2.5 py-3 ${isToday ? "bg-[#ebebf0]" : "bg-[#efeff4]"}`}
            >
              <h2 className="mb-1 flex items-center gap-2 text-[13px] font-semibold text-muted">
                {DAY_NAMES[index]}
                <span
                  className={`inline-flex h-[30px] w-[30px] items-center justify-center rounded-full text-[17px] font-semibold ${
                    isToday ? "bg-accent text-white" : "text-foreground"
                  }`}
                >
                  {day.getDate()}
                </span>
              </h2>

              {dayPosts.map((post) => {
                const style = statusStyle(post.status);
                const selected = post.id === selectedId;
                return (
                  <button
                    key={post.id}
                    type="button"
                    onClick={() => onPick(post)}
                    aria-pressed={selected}
                    className={`press flex w-full gap-2.5 rounded-xl bg-surface p-2.5 text-left ${
                      selected
                        ? "shadow-[0_0_0_2px_var(--color-accent)]"
                        : "shadow-[0_1px_2px_rgba(0,0,0,0.06)] hover:shadow-[0_2px_8px_rgba(0,0,0,0.08)]"
                    }`}
                  >
                    <PlayTile className="h-[53px] w-[30px]" />
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="flex items-center justify-between gap-1.5">
                        <span className="text-[13px] font-semibold tabular-nums">
                          {formatTime(postDate(post))}
                        </span>
                        {post.trialGraduation && <TrialBadge />}
                      </span>
                      <span className="line-clamp-2 text-[13px] leading-[1.3]">
                        {postTitle(post)}
                      </span>
                      <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${style.text}`}>
                        <span className={`h-[7px] w-[7px] rounded-full ${style.dot}`} />
                        {style.label}
                      </span>
                    </span>
                  </button>
                );
              })}

              {!isPast && (
                <button
                  type="button"
                  onClick={() => onAdd(day)}
                  aria-label={`Add a post on ${day.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}`}
                  className="press inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-dashed border-[#c7c7cc] text-[13px] font-medium text-muted hover:border-border-hover hover:bg-white/60 hover:text-foreground"
                >
                  <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                  Add
                </button>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

export function MonthView({ days, month, posts, today, selectedId, onPick, onAdd }: ViewProps & { days: Date[]; month: number }) {
  return (
    <div className="overflow-x-auto pb-1">
      <div className="panel min-w-[760px] overflow-hidden">
        <div className="grid grid-cols-7 border-b border-border">
          {DAY_NAMES.map((name) => (
            <span key={name} className="px-3 py-2.5 text-xs font-semibold text-muted">
              {name}
            </span>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {days.map((day) => {
            const inMonth = day.getMonth() === month;
            const isToday = sameDay(day, today);
            const isPast = day < today && !isToday;
            const dayPosts = postsOnDay(posts, day);
            const shown = dayPosts.slice(0, 3);
            const label = day.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
            return (
              <div
                key={day.toISOString()}
                className={`flex min-h-[104px] flex-col gap-1 border-b border-r border-surface-hover p-2 ${inMonth ? "bg-surface" : "bg-[#fafafa]"}`}
              >
                {isPast ? (
                  <span
                    className={`inline-flex h-[26px] w-[26px] items-center justify-center text-[13px] font-semibold ${inMonth ? "text-foreground" : "text-[#8e8e93]"}`}
                  >
                    {day.getDate()}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => onAdd(day)}
                    aria-label={`Add a post on ${label}`}
                    className={`press inline-flex h-[26px] w-[26px] items-center justify-center rounded-full text-[13px] font-semibold ${
                      isToday
                        ? "bg-accent text-white"
                        : inMonth
                          ? "text-foreground hover:bg-surface-hover"
                          : "text-[#8e8e93] hover:bg-surface-hover"
                    }`}
                  >
                    {day.getDate()}
                  </button>
                )}
                {shown.map((post) => {
                  const style = statusStyle(post.status);
                  return (
                    <button
                      key={post.id}
                      type="button"
                      onClick={() => onPick(post)}
                      aria-pressed={post.id === selectedId}
                      className={`press flex w-full items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-[7px] px-1.5 py-1 text-left text-xs ${style.soft} ${
                        post.id === selectedId ? "shadow-[0_0_0_2px_var(--color-accent)]" : ""
                      }`}
                    >
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${style.dot}`} />
                      <span className="font-semibold tabular-nums">{formatTime(postDate(post))}</span>
                      <span className="truncate">{postTitle(post)}</span>
                    </button>
                  );
                })}
                {dayPosts.length > shown.length && (
                  <span className="px-1.5 text-xs text-muted">
                    {dayPosts.length - shown.length} more
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
