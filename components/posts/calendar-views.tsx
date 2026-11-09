"use client";

/**
 * Week and month views for the Posts page. A card is one post (its platform
 * rows grouped), with a mark per platform colored by that platform's status.
 * Every card and every "add" target is a real button, so the calendar works
 * from the keyboard.
 */

import {
  DAY_NAMES,
  formatTime,
  groupsOnDay,
  groupStatus,
  PLATFORM_LABEL,
  PLATFORM_MARK,
  postDate,
  sameDay,
  statusStyle,
  type PostGroup,
} from "@/lib/publishing/calendar";

interface ViewProps {
  groups: PostGroup[];
  today: Date;
  selectedKey: string | null;
  onPick: (group: PostGroup) => void;
  onAdd: (day: Date) => void;
}

function groupTitle(group: PostGroup) {
  const firstLine = group.lead.caption.split("\n")[0].trim();
  return firstLine || "Untitled reel";
}

function longDay(day: Date) {
  return day.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
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

/** Per-platform marks, each tinted by that row's status. */
export function PlatformMarks({ group }: { group: PostGroup }) {
  return (
    <span className="flex flex-wrap gap-1">
      {group.rows.map((row) => {
        const style = statusStyle(row.status);
        return (
          <span
            key={row.id}
            title={`${PLATFORM_LABEL[row.platform]}: ${style.label}`}
            className={`inline-flex items-center gap-1 rounded px-1 py-0.5 text-[10px] font-bold leading-none ${style.soft} ${style.text}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
            {PLATFORM_MARK[row.platform]}
            <span className="sr-only">
              {PLATFORM_LABEL[row.platform]} {style.label}
            </span>
          </span>
        );
      })}
    </span>
  );
}

export function WeekView({
  days,
  groups,
  today,
  selectedKey,
  onPick,
  onAdd,
  compact = false,
}: ViewProps & { days: Date[]; compact?: boolean }) {
  // Compact while the composer is open, so all seven days still fit beside it.
  return (
    <div className="overflow-x-auto pb-1">
      <div className={`grid grid-cols-7 ${compact ? "min-w-[588px] gap-1.5" : "min-w-[840px] gap-2.5"}`}>
        {days.map((day, index) => {
          const isToday = sameDay(day, today);
          const dayGroups = groupsOnDay(groups, day);
          const isPast = day < today && !isToday;
          return (
            <section
              key={day.toISOString()}
              aria-label={longDay(day)}
              className={`flex min-h-[520px] min-w-0 flex-col gap-2 rounded-2xl py-3 ${compact ? "px-1.5" : "px-2.5"} ${isToday ? "bg-[#ebebf0]" : "bg-[#efeff4]"}`}
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

              {dayGroups.map((group) => {
                const selected = group.key === selectedKey;
                return (
                  <button
                    key={group.key}
                    type="button"
                    onClick={() => onPick(group)}
                    aria-pressed={selected}
                    className={`press flex w-full gap-2.5 rounded-xl bg-surface p-2.5 text-left ${
                      selected
                        ? "shadow-[0_0_0_2px_var(--color-accent)]"
                        : "shadow-[0_1px_2px_rgba(0,0,0,0.06)] hover:shadow-[0_2px_8px_rgba(0,0,0,0.08)]"
                    }`}
                  >
                    {!compact && <PlayTile className="h-[53px] w-[30px]" />}
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="flex items-center justify-between gap-1.5">
                        <span className="text-[13px] font-semibold tabular-nums">
                          {formatTime(postDate(group.lead))}
                        </span>
                        {group.lead.trialGraduation && <TrialBadge />}
                      </span>
                      <span className="line-clamp-2 text-[13px] leading-[1.3]">{groupTitle(group)}</span>
                      <PlatformMarks group={group} />
                    </span>
                  </button>
                );
              })}

              {!isPast && (
                <button
                  type="button"
                  onClick={() => onAdd(day)}
                  aria-label={`Add a post on ${longDay(day)}`}
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

export function MonthView({
  days,
  month,
  groups,
  today,
  selectedKey,
  onPick,
  onAdd,
}: ViewProps & { days: Date[]; month: number }) {
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
            const dayGroups = groupsOnDay(groups, day);
            const shown = dayGroups.slice(0, 3);
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
                    aria-label={`Add a post on ${longDay(day)}`}
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
                {shown.map((group) => {
                  const style = statusStyle(groupStatus(group));
                  return (
                    <button
                      key={group.key}
                      type="button"
                      onClick={() => onPick(group)}
                      aria-pressed={group.key === selectedKey}
                      className={`press flex w-full items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-[7px] px-1.5 py-1 text-left text-xs ${style.soft} ${
                        group.key === selectedKey ? "shadow-[0_0_0_2px_var(--color-accent)]" : ""
                      }`}
                    >
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${style.dot}`} />
                      <span className="font-semibold tabular-nums">{formatTime(postDate(group.lead))}</span>
                      <span className="truncate">{groupTitle(group)}</span>
                      <span className="ml-auto shrink-0 text-[10px] font-bold text-muted">
                        {group.rows.map((row) => PLATFORM_MARK[row.platform]).join(" ")}
                      </span>
                    </button>
                  );
                })}
                {dayGroups.length > shown.length && (
                  <span className="px-1.5 text-xs text-muted">{dayGroups.length - shown.length} more</span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
