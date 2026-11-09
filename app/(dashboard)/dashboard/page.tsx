"use client";

/**
 * Dashboard Home Page
 *
 * What is going out next, this week's posting plan, DM results, and where
 * the account is connected.
 */

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import AccountSelect, { type AccountOption } from "@/components/account-select";
import { TrialBadge } from "@/components/posts/calendar-views";
import StatCard from "@/components/stat-card";
import StatusBadge from "@/components/status-badge";
import {
  DAY_NAMES,
  formatTime,
  formatWhen,
  postDate,
  postsOnDay,
  sameDay,
  statusStyle,
  weekDays,
  type PostRow,
} from "@/lib/publishing/calendar";

interface DashboardStats {
  userName: string | null;
  contactsCount: number;
  activeAutomations: number;
  dmsSentMonth: number;
  dmsSkippedMonth: number;
  dmsFailedMonth: number;
  clicksThisMonth: number;
  ctrThisMonth: number;
  instagramAccounts: AccountOption[];
  topKeywords: { keyword: string; count: number }[];
  dailyDMs: { date: string; count: number }[];
  recentLogs: Array<{
    id: string;
    commenterName: string | null;
    commentText: string;
    status: string;
    createdAt: string;
    automation: { name: string };
    instagramAccount?: { username: string };
  }>;
}

const UPCOMING = ["SCHEDULED", "CREATING", "PROCESSING", "PUBLISHING"];

const COMING_PLATFORMS = [
  { name: "YouTube", mark: "YT", status: "Coming next" },
  { name: "TikTok", mark: "TT", status: "Coming next" },
  { name: "X", mark: "X", status: "Coming next" },
  { name: "Gist", mark: "G", status: "No posting API yet" },
];

function Card({
  title,
  action,
  className = "",
  children,
}: {
  title: string;
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`panel flex min-w-0 flex-col gap-4 p-6 ${className}`}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="title-section">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [posts, setPosts] = useState<PostRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedAccountId, setSelectedAccountId] = useState("all");
  const now = useMemo(() => new Date(), []);

  useEffect(() => {
    const params = new URLSearchParams();
    if (selectedAccountId !== "all") {
      params.set("instagramAccountId", selectedAccountId);
    }

    Promise.all([
      fetch(`/api/dashboard/stats${params.size ? `?${params}` : ""}`).then((r) => r.json()),
      fetch("/api/posts?limit=200").then((r) => r.json()),
    ])
      .then(([statsData, postsData]) => {
        if (statsData.success) setStats(statsData.data);
        if (postsData.success) setPosts(postsData.data);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [selectedAccountId]);

  function handleAccountChange(accountId: string) {
    setLoading(true);
    setSelectedAccountId(accountId);
  }

  const visiblePosts =
    selectedAccountId === "all"
      ? posts
      : posts.filter((post) => post.instagramAccount.id === selectedAccountId);

  const nextPost = visiblePosts
    .filter((post) => UPCOMING.includes(post.status))
    .sort((a, b) => postDate(a).getTime() - postDate(b).getTime())[0];

  const week = weekDays(now).map((day, index) => {
    const dayPosts = postsOnDay(visiblePosts, day);
    const trials = dayPosts.filter((post) => post.trialGraduation).length;
    let summary = "Nothing scheduled";
    if (dayPosts.length === 1) {
      summary = `${formatTime(postDate(dayPosts[0]))} reel${trials ? ", trial" : ""}`;
    } else if (dayPosts.length > 1) {
      summary = `${dayPosts.length} reels${trials ? `, ${trials} trial` : ""}`;
    }
    return { day, name: DAY_NAMES[index], summary, empty: dayPosts.length === 0 };
  });

  if (loading) {
    return (
      <div className="flex flex-col gap-5">
        <div className="h-16 w-72 rounded-2xl bg-fill" />
        <div className="grid gap-5 lg:grid-cols-3">
          <div className="panel h-64 lg:col-span-2" />
          <div className="panel h-64" />
        </div>
        <div className="grid grid-cols-2 gap-5 xl:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="panel h-32" />
          ))}
        </div>
      </div>
    );
  }

  const dailyDMs = stats?.dailyDMs ?? [];
  const maxDM = Math.max(...dailyDMs.map((d) => d.count), 1);
  const weekDMs = dailyDMs.reduce((sum, d) => sum + d.count, 0);
  const accounts = stats?.instagramAccounts ?? [];

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4 pb-2">
        <div className="flex flex-col gap-1">
          <span className="text-[13px] font-semibold text-muted">
            {now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
          </span>
          <h1 className="title-large">Hello, {stats?.userName ?? "there"}</h1>
        </div>
        <div className="flex flex-wrap items-end gap-2.5">
          {accounts.length > 1 && (
            <AccountSelect
              accounts={accounts}
              value={selectedAccountId}
              onChange={handleAccountChange}
            />
          )}
          <Link
            href="/campaigns/new"
            className="press inline-flex min-h-11 items-center rounded-full bg-fill px-[18px] text-[15px] font-medium hover:bg-border"
          >
            New campaign
          </Link>
          <Link
            href="/posts"
            className="press inline-flex min-h-11 items-center gap-2 rounded-full bg-accent px-[18px] text-[15px] font-semibold text-white hover:bg-accent-hover"
          >
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
            New post
          </Link>
        </div>
      </header>

      <div className="flex flex-wrap gap-5">
        <Card title="Up next" className="flex-[2_1_480px]">
          {nextPost ? (
            <div className="flex flex-wrap gap-5">
              <div className="flex h-[199px] w-28 shrink-0 items-center justify-center overflow-hidden rounded-[14px] bg-foreground">
                <svg aria-hidden="true" width="34" height="34" viewBox="0 0 24 24" fill="#ffffff">
                  <path d="M8 5.5v13l11-6.5z" />
                </svg>
              </div>
              <div className="flex min-w-[240px] flex-1 flex-col gap-2.5">
                <div className="flex flex-col gap-0.5">
                  <span className="text-2xl font-semibold tracking-[-0.015em]">
                    {formatWhen(postDate(nextPost), now)}
                  </span>
                  <span className="text-sm text-muted">
                    Reel on Instagram · @{nextPost.instagramAccount.username}
                  </span>
                </div>
                {nextPost.caption && (
                  <p className="line-clamp-3 text-[15px] leading-[1.45]">{nextPost.caption}</p>
                )}
                <div className="flex flex-wrap gap-2">
                  {nextPost.trialGraduation && (
                    <span className="inline-flex items-center gap-2 rounded-lg bg-surface-hover px-2.5 py-1.5 text-[13px] font-semibold">
                      <TrialBadge />
                      {nextPost.trialGraduation === "SS_PERFORMANCE"
                        ? "Shares to followers if it performs well"
                        : "You share it to followers"}
                    </span>
                  )}
                  <span
                    className={`inline-flex items-center rounded-lg px-2.5 py-1.5 text-[13px] font-semibold ${statusStyle(nextPost.status).text} ${statusStyle(nextPost.status).soft}`}
                  >
                    {statusStyle(nextPost.status).label}
                  </span>
                </div>
                <div className="mt-auto flex flex-wrap gap-2.5 pt-1">
                  <Link
                    href="/posts"
                    className="press inline-flex min-h-10 items-center rounded-full bg-surface-hover px-4 text-sm font-semibold text-accent hover:bg-fill"
                  >
                    Open calendar
                  </Link>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 py-6 text-center">
              <p className="text-[15px] font-semibold">Nothing scheduled</p>
              <p className="text-sm text-muted">
                Queue a Reel and it shows here with a countdown.
              </p>
              <Link
                href="/posts"
                className="press inline-flex min-h-10 items-center rounded-full bg-accent px-4 text-sm font-semibold text-white hover:bg-accent-hover"
              >
                Schedule a Reel
              </Link>
            </div>
          )}
        </Card>

        <Card title="This week" className="flex-[1_1_300px]">
          <div className="-mx-2.5 flex flex-col">
            {week.map((row) => {
              const isToday = sameDay(row.day, now);
              return (
                <Link
                  key={row.name}
                  href="/posts"
                  className={`press flex min-h-11 items-center gap-3 rounded-xl px-2.5 hover:bg-surface-hover ${isToday ? "bg-canvas" : ""}`}
                >
                  <span className="w-[34px] text-[13px] font-semibold text-muted">{row.name}</span>
                  <span
                    className={`inline-flex h-7 w-7 items-center justify-center rounded-full text-sm font-semibold ${
                      isToday ? "bg-accent text-white" : ""
                    }`}
                  >
                    {row.day.getDate()}
                  </span>
                  <span className={`min-w-0 flex-1 truncate text-sm ${row.empty ? "text-muted" : ""}`}>
                    {row.summary}
                  </span>
                </Link>
              );
            })}
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Active campaigns"
          value={stats?.activeAutomations ?? 0}
          note={`${stats?.contactsCount ?? 0} contacts`}
        />
        <StatCard
          label="DMs sent"
          value={stats?.dmsSentMonth ?? 0}
          note={`This month · ${stats?.dmsFailedMonth ?? 0} failed, ${stats?.dmsSkippedMonth ?? 0} skipped`}
        />
        <StatCard label="Link clicks" value={stats?.clicksThisMonth ?? 0} note="This month, from DM links" />
        <StatCard
          label="Click rate"
          value={`${stats?.ctrThisMonth ?? 0}%`}
          note={`${stats?.clicksThisMonth ?? 0} clicks from ${stats?.dmsSentMonth ?? 0} DMs`}
        />
      </div>

      <div className="flex flex-wrap gap-5">
        <Card
          title="DMs, last 7 days"
          action={<span className="text-[13px] text-muted">{weekDMs} sent</span>}
          className="flex-[2_1_420px]"
        >
          <div className="relative flex h-48 flex-col justify-end">
            {weekDMs === 0 && (
              <div className="absolute inset-x-0 top-0 bottom-8 flex flex-col items-center justify-center gap-1 text-center">
                <span className="text-[15px] font-semibold">No DMs this week</span>
                <span className="text-[13px] text-muted">
                  Replies appear here as soon as someone comments a keyword.
                </span>
              </div>
            )}
            <div className="flex h-full items-end gap-2 border-b-2 border-border pb-0">
              {dailyDMs.map((day) => (
                <div key={day.date} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1.5">
                  {day.count > 0 && (
                    <span className="text-xs font-medium tabular-nums text-muted">{day.count}</span>
                  )}
                  <div
                    className="w-full max-w-10 rounded-t-md bg-accent"
                    style={{ height: day.count > 0 ? `${Math.max((day.count / maxDM) * 80, 4)}%` : 0 }}
                  />
                </div>
              ))}
            </div>
            <div className="flex gap-2 pt-2">
              {dailyDMs.map((day) => (
                <span key={day.date} className="min-w-0 flex-1 truncate text-center text-xs text-muted">
                  {day.date}
                </span>
              ))}
            </div>
          </div>
        </Card>

        <Card title="Top keywords" className="flex-[1_1_220px]">
          {stats?.topKeywords.length ? (
            <ol className="-mt-1 flex flex-col">
              {stats.topKeywords.map((keyword, index) => (
                <li
                  key={keyword.keyword}
                  className="flex min-h-9 items-center gap-3 border-b border-surface-hover last:border-0"
                >
                  <span className="w-4 text-[13px] font-semibold tabular-nums text-muted">{index + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-[15px]">{keyword.keyword}</span>
                  <span className="text-[13px] tabular-nums text-muted">{keyword.count}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="py-6 text-sm text-muted">No keyword matches yet</p>
          )}
        </Card>

        <Card
          title="Recent activity"
          action={
            <Link href="/logs" className="text-sm font-semibold text-accent hover:underline">
              See all
            </Link>
          }
          className="flex-[1_1_280px]"
        >
          {stats?.recentLogs.length ? (
            <ul className="-mt-1 flex max-h-64 flex-col overflow-y-auto">
              {stats.recentLogs.map((log) => (
                <li
                  key={log.id}
                  className="flex min-h-11 items-center justify-between gap-3 border-b border-surface-hover py-1.5 last:border-0"
                >
                  <div className="min-w-0">
                    <p className="truncate text-[15px]">@{log.commenterName ?? "unknown"}</p>
                    <p className="truncate text-xs text-muted">{log.commentText}</p>
                  </div>
                  <StatusBadge status={log.status} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-6 text-sm text-muted">No activity yet</p>
          )}
        </Card>
      </div>

      <Card title="Where you post">
        <div className="flex flex-wrap gap-3">
          <div className="flex min-w-0 flex-[1_1_180px] items-center gap-3 rounded-[14px] bg-canvas p-3.5">
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-[10px] bg-foreground text-[13px] font-bold text-white">
              IG
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="text-[15px] font-semibold">Instagram</span>
              {accounts.length > 0 ? (
                <span className="truncate text-[13px] text-success">
                  {accounts.length === 1 ? `@${accounts[0].username}` : `${accounts.length} accounts`}
                </span>
              ) : (
                <a href="/api/instagram/connect" className="text-[13px] font-semibold text-accent">
                  Connect
                </a>
              )}
            </span>
          </div>
          {COMING_PLATFORMS.map((platform) => (
            <div
              key={platform.name}
              className="flex min-w-0 flex-[1_1_180px] items-center gap-3 rounded-[14px] bg-canvas p-3.5"
            >
              <span className="inline-flex h-9 w-9 items-center justify-center rounded-[10px] bg-[#8e8e93] text-[13px] font-bold text-white">
                {platform.mark}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="text-[15px] font-semibold">{platform.name}</span>
                <span className="text-[13px] text-muted">{platform.status}</span>
              </span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
