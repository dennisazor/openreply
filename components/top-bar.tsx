"use client";

/**
 * Top Bar
 *
 * Translucent bar over the scrolling content: mobile menu button, the page
 * title (pages with their own large title leave it out), and connection status.
 */

import { usePathname } from "next/navigation";

const pageTitles: Record<string, string> = {
  "/overview": "Overview",
  "/inbox": "Inbox",
  "/campaigns": "Campaigns",
  "/campaigns/new": "New Campaign",
  "/campaigns/import": "Import Campaigns",
  "/automations": "Campaigns",
  "/automations/new": "New Campaign",
  "/files": "Files",
  "/logs": "DM Logs",
  "/settings": "Settings",
  "/diagnostics": "Diagnostics",
};

// These pages open with a large title of their own.
const LARGE_TITLE_PAGES = new Set(["/dashboard", "/posts"]);

interface TopBarProps {
  onMenuClick: () => void;
  instagramUsername: string | null;
  instagramAccountCount: number;
}

export default function TopBar({
  onMenuClick,
  instagramUsername,
  instagramAccountCount,
}: TopBarProps) {
  const pathname = usePathname();
  const title = LARGE_TITLE_PAGES.has(pathname)
    ? null
    : (pageTitles[pathname] ??
      (pathname.startsWith("/campaigns/") ? "Campaign" : null));

  return (
    <header className="material-light sticky top-0 z-30 flex shrink-0 items-center justify-between gap-3 h-14 px-4 lg:px-10">
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          onClick={onMenuClick}
          className="press lg:hidden shrink-0 inline-flex h-10 w-10 items-center justify-center rounded-full text-foreground hover:bg-fill"
          aria-label="Open menu"
        >
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
        {title && (
          <h1 className="truncate text-[17px] font-semibold tracking-[-0.01em]">
            {title}
          </h1>
        )}
      </div>

      {instagramAccountCount > 0 ? (
        <p className="shrink-0 truncate text-sm text-muted">
          {instagramAccountCount > 1
            ? `${instagramAccountCount} accounts`
            : `@${instagramUsername}`}
        </p>
      ) : (
        <a
          href="/api/instagram/connect"
          className="press shrink-0 whitespace-nowrap inline-flex min-h-10 items-center rounded-full bg-accent px-4 text-sm font-semibold text-white hover:bg-accent-hover"
        >
          {/* Full label needs more room than a 360px header has to spare. */}
          <span className="sm:hidden">Connect</span>
          <span className="hidden sm:inline">Connect Instagram</span>
        </a>
      )}
    </header>
  );
}
