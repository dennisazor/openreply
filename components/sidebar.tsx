"use client";

/**
 * Sidebar Navigation
 *
 * Translucent sidebar with icons; the active page sits on a white pill.
 * Slides in as a drawer below the lg breakpoint.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";

const ICONS: Record<string, React.ReactNode> = {
  dashboard: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="2" />
      <rect x="14" y="3" width="7" height="7" rx="2" />
      <rect x="3" y="14" width="7" height="7" rx="2" />
      <rect x="14" y="14" width="7" height="7" rx="2" />
    </>
  ),
  overview: <path d="M4 20V10M10 20V4M16 20v-7M21 20H3" />,
  inbox: (
    <>
      <path d="M3 13l2.5-7h13L21 13v6H3z" />
      <path d="M3 13h5l1.5 2.5h5L16 13h5" />
    </>
  ),
  campaigns: <path d="M4 5h16v11H9l-5 4z" />,
  posts: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="3" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </>
  ),
  files: (
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  ),
  logs: <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" />
    </>
  ),
  diagnostics: <path d="M3 12h4l3-7 4 14 3-7h4" />,
};

const mainItems = [
  { label: "Dashboard", href: "/dashboard", icon: "dashboard" },
  { label: "Overview", href: "/overview", icon: "overview" },
  { label: "Inbox", href: "/inbox", icon: "inbox" },
  { label: "Campaigns", href: "/campaigns", icon: "campaigns" },
  { label: "Posts", href: "/posts", icon: "posts" },
  { label: "Files", href: "/files", icon: "files" },
  { label: "DM Logs", href: "/logs", icon: "logs" },
];

const footerItems = [
  { label: "Settings", href: "/settings", icon: "settings" },
  { label: "Diagnostics", href: "/diagnostics", icon: "diagnostics" },
];

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
  workspaceName: string;
}

export default function Sidebar({
  isOpen,
  onClose,
  workspaceName,
}: SidebarProps) {
  const pathname = usePathname();

  function renderItem(item: { label: string; href: string; icon: string }) {
    const isActive =
      pathname === item.href || pathname.startsWith(item.href + "/");
    return (
      <Link
        key={item.href}
        href={item.href}
        onClick={onClose}
        aria-current={isActive ? "page" : undefined}
        className={`press flex min-h-9 items-center gap-2.5 rounded-[9px] px-2.5 text-sm ${
          isActive
            ? "bg-surface font-semibold text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
            : "text-[#3a3a3c] hover:bg-black/[0.04]"
        }`}
      >
        <svg
          aria-hidden="true"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={isActive ? "text-accent" : ""}
        >
          {ICONS[item.icon]}
        </svg>
        {item.label}
      </Link>
    );
  }

  return (
    <>
      {/* Mobile overlay */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/30 lg:hidden"
          onClick={onClose}
        />
      )}

      <aside
        className={`
          material fixed top-0 left-0 z-50 h-dvh w-64 max-w-[85vw] shrink-0 border-r border-black/[0.06] flex flex-col
          transition-transform duration-200 ease-out
          lg:h-full lg:translate-x-0 lg:static lg:z-auto
          ${isOpen ? "translate-x-0" : "-translate-x-full"}
        `}
      >
        <Link
          href="/dashboard"
          onClick={onClose}
          className="flex items-center gap-2.5 px-6 pt-6 pb-5"
        >
          <span className="inline-flex h-[30px] w-[30px] items-center justify-center rounded-[9px] bg-accent">
            <svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 5h16v11H9l-5 4z" />
            </svg>
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="text-[15px] font-semibold tracking-[-0.01em]">
              OpenReply
            </span>
            <span className="truncate text-xs text-muted">{workspaceName}</span>
          </span>
        </Link>

        <nav
          aria-label="Main"
          className="flex flex-1 flex-col gap-1 overflow-y-auto px-3.5 pb-4"
        >
          {mainItems.map(renderItem)}
          <div className="mx-2.5 my-2.5 h-px bg-black/[0.08]" />
          {footerItems.map(renderItem)}
        </nav>
      </aside>
    </>
  );
}
