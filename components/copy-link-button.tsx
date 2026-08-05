"use client";

/**
 * Copy-to-clipboard button for a public file URL.
 *
 * Builds the absolute URL from window.location.origin so it is always correct
 * regardless of which domain the dashboard is being served from.
 */

import { useState } from "react";

interface CopyLinkButtonProps {
  urlPath: string;
  label?: string;
}

export default function CopyLinkButton({
  urlPath,
  label = "Copy link",
}: CopyLinkButtonProps) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    const absolute =
      typeof window === "undefined" ? urlPath : window.location.origin + urlPath;
    try {
      await navigator.clipboard.writeText(absolute);
    } catch {
      // Clipboard API needs a secure context; fall back to a temp textarea.
      const el = document.createElement("textarea");
      el.value = absolute;
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-live="polite"
      className={`
        shrink-0 px-3 py-1.5 rounded text-xs font-medium border transition-colors
        ${
          copied
            ? "bg-accent text-white border-accent"
            : "border-border text-muted hover:text-foreground hover:border-border-hover hover:bg-surface-hover"
        }
      `}
    >
      {copied ? "Copied" : label}
    </button>
  );
}
