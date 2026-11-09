"use client";

/**
 * Settings section for the publishing connections beyond Instagram Login:
 * Facebook (Page publishing, sounds; its Page token never expires) and Threads.
 */

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

interface ConnectionsData {
  canManage: boolean;
  instagramAccounts: {
    id: string;
    username: string;
    facebookPageId: string | null;
    facebookPageName: string | null;
  }[];
  threadsAccounts: { id: string; username: string; tokenExpiresAt: string | null }[];
  configured: { facebook: boolean; threads: boolean; uploads: boolean };
}

const NOTICES: Record<string, Record<string, { tone: "success" | "error" | "warning"; text: string }>> = {
  facebook: {
    connected: { tone: "success", text: "Facebook connected. Your Page and sounds are ready." },
    denied: { tone: "warning", text: "Facebook connection cancelled." },
    invalid: { tone: "error", text: "The Facebook login link expired. Try again." },
    forbidden: { tone: "error", text: "Only workspace owners and admins can connect Facebook." },
    no_match: {
      tone: "warning",
      text: "None of your Facebook Pages is linked to a connected Instagram account. Link the Page to your Instagram in Meta Business settings, or connect that Instagram account first.",
    },
    no_pages: {
      tone: "warning",
      text: "No Facebook Pages came back. Make sure you picked your Page on the Facebook screen and that you have a role on it.",
    },
    misconfigured: { tone: "error", text: "Facebook is not set up on this server (missing environment variables)." },
    error: { tone: "error", text: "Facebook connection failed. Diagnostics has the details." },
  },
  threads: {
    connected: { tone: "success", text: "Threads connected." },
    denied: { tone: "warning", text: "Threads connection cancelled." },
    invalid: { tone: "error", text: "The Threads login link expired. Try again." },
    forbidden: { tone: "error", text: "Only workspace owners and admins can connect Threads." },
    already_connected: { tone: "warning", text: "That Threads profile is connected to another workspace." },
    misconfigured: { tone: "error", text: "Threads is not set up on this server (missing environment variables)." },
    error: { tone: "error", text: "Threads connection failed. Diagnostics has the details." },
  },
};

const TONE: Record<string, string> = {
  success: "bg-success-soft text-success",
  error: "bg-error-soft text-error",
  warning: "bg-warning-soft text-warning",
};

const rowClass =
  "flex flex-col gap-3 rounded-xl border border-border p-4 sm:flex-row sm:items-center sm:justify-between";
const primaryButton =
  "press inline-flex min-h-10 items-center justify-center rounded-full bg-accent px-4 text-sm font-semibold text-white hover:bg-accent-hover";
const quietButton =
  "press inline-flex min-h-10 items-center justify-center rounded-full px-4 text-sm font-medium text-error hover:bg-error-soft disabled:opacity-50";

export default function ConnectionsSettings() {
  const params = useSearchParams();
  const [data, setData] = useState<ConnectionsData | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    () =>
      fetch("/api/connections")
        .then((res) => res.json())
        .then((body) => {
          if (body.success) setData(body.data);
        }),
    []
  );

  useEffect(() => {
    fetch("/api/connections")
      .then((res) => res.json())
      .then((body) => {
        if (body.success) setData(body.data);
      });
  }, []);

  async function remove(body: object, key: string) {
    setBusy(key);
    try {
      await fetch("/api/connections", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await load();
    } finally {
      setBusy(null);
    }
  }

  const notices = (["facebook", "threads"] as const)
    .map((kind) => {
      const code = params.get(kind);
      return code ? NOTICES[kind][code] : undefined;
    })
    .filter(Boolean);

  return (
    <section className="panel p-5 sm:p-6">
      <h2 className="title-section mb-1">Post to Facebook and Threads</h2>
      <p className="mb-5 text-[13px] text-muted">
        Connecting Facebook also unlocks trending sounds for Instagram, and its
        Page connection does not expire.
      </p>

      {notices.map((notice) => (
        <p key={notice!.text} className={`mb-4 rounded-xl px-3.5 py-3 text-sm ${TONE[notice!.tone]}`}>
          {notice!.text}
        </p>
      ))}

      {!data ? (
        <div className="h-24 rounded-xl bg-surface-hover" />
      ) : (
        <div className="flex flex-col gap-3">
          {data.instagramAccounts.length === 0 && (
            <p className="text-sm text-muted">Connect Instagram first, then link its Facebook Page here.</p>
          )}
          {data.instagramAccounts.map((account) => (
            <div key={account.id} className={rowClass}>
              <div className="min-w-0">
                <p className="text-sm font-semibold">Facebook for @{account.username}</p>
                <p className="mt-0.5 text-xs text-muted">
                  {account.facebookPageName
                    ? `Page: ${account.facebookPageName} · never expires`
                    : data.configured.facebook
                      ? "Not connected"
                      : "Not set up on this server: add FACEBOOK_APP_ID (see docs/setup.md)"}
                </p>
              </div>
              {data.canManage && data.configured.facebook && (
                <div className="flex gap-2">
                  {account.facebookPageName && (
                    <button
                      type="button"
                      disabled={busy === `fb:${account.id}`}
                      onClick={() => void remove({ kind: "facebook", instagramAccountId: account.id }, `fb:${account.id}`)}
                      className={quietButton}
                    >
                      Remove
                    </button>
                  )}
                  <a href="/api/facebook/connect" className={primaryButton}>
                    {account.facebookPageName ? "Reconnect" : "Connect with Facebook"}
                  </a>
                </div>
              )}
            </div>
          ))}

          <div className={rowClass}>
            <div className="min-w-0">
              <p className="text-sm font-semibold">Threads</p>
              <p className="mt-0.5 text-xs text-muted">
                {data.threadsAccounts[0]
                  ? `@${data.threadsAccounts[0].username} · renews automatically`
                  : data.configured.threads
                    ? "Not connected"
                    : "Not set up on this server: add THREADS_APP_ID (see docs/setup.md)"}
              </p>
            </div>
            {data.canManage && data.configured.threads && (
              <div className="flex gap-2">
                {data.threadsAccounts[0] && (
                  <button
                    type="button"
                    disabled={busy === "threads"}
                    onClick={() =>
                      void remove({ kind: "threads", threadsAccountId: data.threadsAccounts[0].id }, "threads")
                    }
                    className={quietButton}
                  >
                    Remove
                  </button>
                )}
                <a href="/api/threads/connect" className={primaryButton}>
                  {data.threadsAccounts[0] ? "Reconnect" : "Connect Threads"}
                </a>
              </div>
            )}
          </div>

          {!data.configured.uploads && (
            <p className="text-xs text-muted">
              Video uploads are off until a Vercel Blob store is connected to this
              project; pasting a video link still works.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
