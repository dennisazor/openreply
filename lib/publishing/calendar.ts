/**
 * Calendar helpers for the Posts page and the dashboard. Client-safe (no
 * server imports). All dates are the viewer's local time; weeks start Monday.
 */

export type Platform = "INSTAGRAM" | "FACEBOOK" | "THREADS";

/** One platform's row of a post, as the /api/posts JSON returns it. */
export interface PostRow {
  id: string;
  groupId: string | null;
  platform: Platform;
  status: string;
  caption: string;
  videoUrl: string;
  trialGraduation: "MANUAL" | "SS_PERFORMANCE" | null;
  shareToFeed: boolean;
  audioId: string | null;
  audioTitle: string | null;
  audioVolume: number | null;
  videoVolume: number | null;
  publishAt: string;
  publishedAt: string | null;
  permalink: string | null;
  errorMessage: string | null;
  instagramAccount: { id: string; username: string; facebookPageName: string | null } | null;
  threadsAccount: { id: string; username: string } | null;
}

/** A post as the calendar shows it: its platform rows together. */
export interface PostGroup {
  key: string;
  rows: PostRow[];
  /** The row whose content and time stand for the group (Instagram first). */
  lead: PostRow;
}

export const PLATFORM_ORDER: Platform[] = ["INSTAGRAM", "FACEBOOK", "THREADS"];
export const PLATFORM_LABEL: Record<Platform, string> = {
  INSTAGRAM: "Instagram",
  FACEBOOK: "Facebook",
  THREADS: "Threads",
};
export const PLATFORM_MARK: Record<Platform, string> = {
  INSTAGRAM: "IG",
  FACEBOOK: "FB",
  THREADS: "TH",
};
/** Threads caps post text at 500 characters; Facebook Reels run 3 to 90 s. */
export const THREADS_TEXT_LIMIT = 500;
export const FACEBOOK_REEL_MAX_SECONDS = 90;

/** Groups rows by groupId, leaving out canceled rows and empty groups. */
export function groupPosts(rows: PostRow[]): PostGroup[] {
  const groups = new Map<string, PostRow[]>();
  for (const row of rows) {
    if (row.status === "CANCELED") continue;
    const key = row.groupId ?? row.id;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()].map(([key, groupRows]) => {
    const sorted = [...groupRows].sort(
      (a, b) => PLATFORM_ORDER.indexOf(a.platform) - PLATFORM_ORDER.indexOf(b.platform)
    );
    return { key, rows: sorted, lead: sorted[0] };
  });
}

const STATUS_RANK = ["FAILED", "CREATING", "PROCESSING", "PUBLISHING", "SCHEDULED", "PUBLISHED"];

/** One status for the whole group: a failure or work in flight wins. */
export function groupStatus(group: PostGroup): string {
  return [...group.rows]
    .map((row) => row.status)
    .sort((a, b) => STATUS_RANK.indexOf(a) - STATUS_RANK.indexOf(b))[0];
}

export const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

export function startOfWeek(date: Date): Date {
  const day = startOfDay(date);
  // getDay(): Sunday 0 ... Saturday 6. Shift so Monday is 0.
  return addDays(day, -((day.getDay() + 6) % 7));
}

export function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Seven days from the Monday on or before `date`. */
export function weekDays(date: Date): Date[] {
  const start = startOfWeek(date);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** Six full weeks covering the month of `date`, starting on a Monday. */
export function monthGrid(date: Date): Date[] {
  const start = startOfWeek(new Date(date.getFullYear(), date.getMonth(), 1));
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

/** The date a post sits on in the calendar: when it went out, else when it is due. */
export function postDate(post: PostRow): Date {
  return new Date(post.publishedAt ?? post.publishAt);
}

export function postsOnDay(posts: PostRow[], day: Date): PostRow[] {
  return posts
    .filter((post) => post.status !== "CANCELED" && sameDay(postDate(post), day))
    .sort((a, b) => postDate(a).getTime() - postDate(b).getTime());
}

export function groupsOnDay(groups: PostGroup[], day: Date): PostGroup[] {
  return groups
    .filter((group) => sameDay(postDate(group.lead), day))
    .sort((a, b) => postDate(a.lead).getTime() - postDate(b.lead).getTime());
}

export function formatTime(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function formatRange(days: Date[]): string {
  const first = days[0];
  const last = days[days.length - 1];
  const month = (d: Date) => d.toLocaleDateString(undefined, { month: "long" });
  if (first.getMonth() === last.getMonth()) {
    return `${month(first)} ${first.getDate()} to ${last.getDate()}, ${last.getFullYear()}`;
  }
  return `${month(first)} ${first.getDate()} to ${month(last)} ${last.getDate()}, ${last.getFullYear()}`;
}

/** "Today at 6:00 PM", "Tomorrow at 9:00 AM", "Fri, Nov 13 at 7:00 PM". */
export function formatWhen(date: Date, now: Date = new Date()): string {
  const time = formatTime(date);
  if (sameDay(date, now)) return `Today at ${time}`;
  if (sameDay(date, addDays(now, 1))) return `Tomorrow at ${time}`;
  if (sameDay(date, addDays(now, -1))) return `Yesterday at ${time}`;
  const day = date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  return `${day} at ${time}`;
}

const pad = (value: number) => String(value).padStart(2, "0");

/** Value for an <input type="date">, in local time. */
export function toDateInput(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Value for an <input type="time">, in local time. */
export function toTimeInput(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Local date and time inputs to an instant; null when either is missing. */
export function fromInputs(date: string, time: string): Date | null {
  if (!date || !time) return null;
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const result = new Date(y, m - 1, d, hh, mm);
  return Number.isNaN(result.getTime()) ? null : result;
}

/** Display style per post status. The in-flight steps read as one state. */
export const POST_STATUS_STYLE: Record<
  string,
  { label: string; text: string; dot: string; soft: string }
> = {
  SCHEDULED: { label: "Scheduled", text: "text-info", dot: "bg-info", soft: "bg-info-soft" },
  CREATING: { label: "Processing", text: "text-warning", dot: "bg-warning", soft: "bg-warning-soft" },
  PROCESSING: { label: "Processing", text: "text-warning", dot: "bg-warning", soft: "bg-warning-soft" },
  PUBLISHING: { label: "Processing", text: "text-warning", dot: "bg-warning", soft: "bg-warning-soft" },
  PUBLISHED: { label: "Published", text: "text-success", dot: "bg-success", soft: "bg-success-soft" },
  FAILED: { label: "Failed", text: "text-error", dot: "bg-error", soft: "bg-error-soft" },
  CANCELED: { label: "Canceled", text: "text-muted", dot: "bg-muted", soft: "bg-surface-hover" },
};

export function statusStyle(status: string) {
  return POST_STATUS_STYLE[status] ?? POST_STATUS_STYLE.SCHEDULED;
}

export function countHashtags(caption: string): number {
  return caption.match(/#[^\s#]+/g)?.length ?? 0;
}
