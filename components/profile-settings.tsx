"use client";

/**
 * Settings section for the signed-in user's display name. The dashboard
 * greets them by its first word.
 */

import { useEffect, useState } from "react";

export default function ProfileSettings() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => {
    fetch("/api/profile")
      .then((res) => res.json())
      .then((data) => {
        if (data.success && data.data) {
          setName(data.data.name ?? "");
          setEmail(data.data.email ?? null);
        }
      });
  }, []);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setState("saving");
    const res = await fetch("/api/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    setState(data.success ? "saved" : "error");
  }

  return (
    <section className="panel p-5 sm:p-6">
      <h2 className="title-section mb-1">Profile</h2>
      <p className="mb-5 text-[13px] text-muted">
        {email ? `Signed in as ${email}. ` : ""}The dashboard greets you by
        your first name.
      </p>
      <form onSubmit={save} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="flex flex-1 flex-col gap-1.5">
          <span className="text-[13px] font-semibold text-[#3a3a3c]">Your name</span>
          <input
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setState("idle");
            }}
            maxLength={80}
            placeholder="Dennis"
            className="min-h-11 rounded-[10px] border border-border-hover bg-surface px-3 text-[15px] text-foreground outline-none focus:border-accent/50"
          />
        </label>
        <button
          type="submit"
          disabled={state === "saving"}
          className="press min-h-11 rounded-full bg-accent px-5 text-[15px] font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
        >
          {state === "saving" ? "Saving..." : "Save"}
        </button>
      </form>
      {state === "saved" && <p className="mt-3 text-sm text-success">Saved.</p>}
      {state === "error" && (
        <p className="mt-3 text-sm text-error">Could not save your name.</p>
      )}
    </section>
  );
}
