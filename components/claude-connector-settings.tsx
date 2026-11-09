"use client";

/**
 * Settings section for the Claude connector: create and revoke the bearer
 * tokens /api/mcp accepts, and show the command that adds the connector.
 */

import { useEffect, useState } from "react";

interface ApiTokenRow {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export default function ClaudeConnectorSettings() {
  const [tokens, setTokens] = useState<ApiTokenRow[]>([]);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const endpoint =
    typeof window === "undefined" ? "" : `${window.location.origin}/api/mcp`;
  const command = `claude mcp add --transport http openreply ${endpoint} --header "Authorization: Bearer ${newToken ?? "<token>"}"`;

  function load() {
    return fetch("/api/api-tokens")
      .then((res) => res.json())
      .then((data) => {
        if (data.success) setTokens(data.data);
      });
  }

  useEffect(() => {
    fetch("/api/api-tokens")
      .then((res) => res.json())
      .then((data) => {
        if (data.success) setTokens(data.data);
      });
  }, []);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/api-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Claude" }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error ?? "Could not create a token");
        return;
      }
      setNewToken(data.data.token);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setBusy(true);
    try {
      await fetch("/api/api-tokens", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel rounded p-4 sm:p-6">
      <h2 className="text-base font-semibold mb-1">Claude connector</h2>
      <p className="text-xs text-muted mb-6">
        Lets Claude schedule and check Reels for this workspace. Anyone with a
        token can post to your connected Instagram accounts, so keep it private
        and revoke it if it leaks.
      </p>

      {newToken && (
        <div className="mb-6 space-y-3 rounded border border-border bg-surface/70 p-3">
          <p className="text-sm font-medium text-foreground">
            Copy this token now. It will not be shown again.
          </p>
          <code className="block break-all text-xs text-foreground">{newToken}</code>
          <p className="text-xs text-muted">Add it to Claude Code with:</p>
          <code className="block break-all text-xs text-foreground">{command}</code>
          <button
            type="button"
            onClick={() => void navigator.clipboard?.writeText(command)}
            className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-border-hover hover:text-foreground"
          >
            Copy command
          </button>
        </div>
      )}

      {tokens.length > 0 && (
        <ul className="mb-4">
          {tokens.map((token) => (
            <li
              key={token.id}
              className="flex items-center justify-between gap-4 border-b border-border py-3 last:border-0"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">
                  {token.name}{" "}
                  <span className="font-normal text-muted">{token.prefix}...</span>
                </p>
                <p className="text-xs text-muted">
                  Created {new Date(token.createdAt).toLocaleDateString()}
                  {token.lastUsedAt
                    ? ` · last used ${new Date(token.lastUsedAt).toLocaleString()}`
                    : " · never used"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void revoke(token.id)}
                disabled={busy}
                className="rounded-lg border border-error/20 px-3 py-1.5 text-xs font-medium text-error transition-colors hover:bg-error/10 disabled:opacity-50"
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="mb-3 text-sm text-error">{error}</p>}

      <button
        type="button"
        onClick={() => void create()}
        disabled={busy}
        className="rounded bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
      >
        Create token
      </button>
    </section>
  );
}
