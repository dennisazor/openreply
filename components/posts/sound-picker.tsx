"use client";

/**
 * Sound picker for Instagram Reels: trending sounds by default, search, a
 * play/pause preview, and the two volume sliders that mix the sound with the
 * clip's own audio (b-roll under a trending sound: original audio near 1).
 */

import { useEffect, useRef, useState } from "react";

export interface Sound {
  id: string;
  title: string;
  artist: string | null;
  durationMs: number | null;
  previewUrl: string | null;
  instagramLink: string | null;
  cover: string | null;
}

export interface ChosenSound {
  id: string;
  title: string;
  audioVolume: number;
  videoVolume: number;
}

interface SoundPickerProps {
  instagramAccountId: string;
  value: ChosenSound | null;
  onChange: (sound: ChosenSound | null) => void;
  disabled?: boolean;
}

function seconds(ms: number | null) {
  if (!ms) return "";
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export default function SoundPicker({ instagramAccountId, value, onChange, disabled }: SoundPickerProps) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<"music" | "original_sound">("music");
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [sounds, setSounds] = useState<Sound[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const params = new URLSearchParams({ type, instagramAccountId });
    if (submitted) params.set("q", submitted);
    let active = true;
    fetch(`/api/sounds?${params}`)
      .then((res) => res.json())
      .then((data) => {
        if (!active) return;
        if (data.success) {
          setSounds(data.data);
          setError(null);
        } else {
          setSounds([]);
          setError(data.error ?? "Could not load sounds.");
        }
      })
      .catch(() => active && setError("Could not reach OpenReply."))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [open, type, submitted, instagramAccountId]);

  // Stop any preview when the picker closes or unmounts.
  useEffect(() => {
    if (!open) audioRef.current?.pause();
    return () => audioRef.current?.pause();
  }, [open]);

  function search(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setSubmitted(query.trim());
  }

  function togglePreview(sound: Sound) {
    if (!sound.previewUrl) return;
    if (playing === sound.id) {
      audioRef.current?.pause();
      setPlaying(null);
      return;
    }
    audioRef.current?.pause();
    const audio = new Audio(sound.previewUrl);
    audio.onended = () => setPlaying(null);
    audioRef.current = audio;
    void audio.play().then(() => setPlaying(sound.id)).catch(() => setPlaying(null));
  }

  if (value && !open) {
    return (
      <div className="flex flex-col gap-3 rounded-xl bg-canvas p-3">
        <div className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 items-center gap-2 text-sm font-semibold">
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-accent">
              <path d="M9 18V5l12-2v13" />
              <circle cx="6" cy="18" r="3" />
              <circle cx="18" cy="16" r="3" />
            </svg>
            <span className="truncate">{value.title}</span>
          </span>
          <span className="flex shrink-0 gap-1">
            <button type="button" disabled={disabled} onClick={() => setOpen(true)} className="press min-h-9 rounded-full px-3 text-[13px] font-semibold text-accent hover:bg-surface">
              Change
            </button>
            <button type="button" disabled={disabled} onClick={() => onChange(null)} className="press min-h-9 rounded-full px-3 text-[13px] font-medium text-muted hover:bg-surface">
              Remove
            </button>
          </span>
        </div>
        {(
          [
            ["audioVolume", "Sound volume"],
            ["videoVolume", "Original audio"],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="flex items-center gap-3 text-[13px]">
            <span className="w-28 shrink-0 text-[#3a3a3c]">{label}</span>
            <input
              type="range"
              min={1}
              max={100}
              value={value[key]}
              disabled={disabled}
              onChange={(event) => onChange({ ...value, [key]: Number(event.target.value) })}
              className="flex-1 accent-accent"
            />
            <span className="w-8 text-right tabular-nums text-muted">{value[key]}</span>
          </label>
        ))}
        <span className="text-xs text-muted">
          B-roll under a sound: keep original audio at 1.
        </span>
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setLoading(true);
          setOpen(true);
        }}
        className="press inline-flex min-h-11 items-center gap-2 self-start rounded-full bg-surface-hover px-4 text-sm font-semibold text-foreground hover:bg-fill disabled:opacity-50"
      >
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 18V5l12-2v13" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="18" cy="16" r="3" />
        </svg>
        Add a sound
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl bg-canvas p-3">
      <div className="flex items-center justify-between gap-2">
        <div role="group" aria-label="Sound type" className="flex rounded-[10px] bg-fill p-[3px]">
          {(
            [
              ["music", "Music"],
              ["original_sound", "Original sounds"],
            ] as const
          ).map(([option, label]) => (
            <button
              key={option}
              type="button"
              aria-pressed={type === option}
              onClick={() => {
                setLoading(true);
                setType(option);
              }}
              className={`press min-h-8 rounded-[8px] px-3 text-[13px] font-semibold ${type === option ? "bg-surface shadow-[0_1px_3px_rgba(0,0,0,0.12)]" : ""}`}
            >
              {label}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => setOpen(false)} className="press min-h-8 rounded-full px-3 text-[13px] font-medium text-muted hover:bg-surface">
          Done
        </button>
      </div>

      <form onSubmit={search} className="flex gap-2">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search, or leave empty for trending"
          aria-label="Search sounds"
          className="min-h-10 flex-1 rounded-[10px] border border-border-hover bg-surface px-3 text-sm outline-none focus:border-accent/50"
        />
        <button type="submit" className="press min-h-10 rounded-full bg-surface px-4 text-sm font-semibold hover:bg-surface-hover">
          Search
        </button>
      </form>

      <p className="text-xs font-semibold text-muted">
        {submitted ? `Results for "${submitted}"` : "Trending now"}
      </p>

      {error ? (
        <p className="text-sm text-error">{error}</p>
      ) : loading ? (
        <div className="flex flex-col gap-2">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-12 rounded-lg bg-fill" />
          ))}
        </div>
      ) : sounds.length === 0 ? (
        <p className="text-sm text-muted">No sounds found.</p>
      ) : (
        <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
          {sounds.map((sound) => (
            <li key={sound.id} className="flex items-center gap-2.5 rounded-lg bg-surface p-2">
              <button
                type="button"
                onClick={() => togglePreview(sound)}
                disabled={!sound.previewUrl}
                aria-label={playing === sound.id ? `Pause ${sound.title}` : `Play ${sound.title}`}
                className="press inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-foreground text-white disabled:opacity-40"
              >
                {playing === sound.id ? (
                  <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z" /></svg>
                ) : (
                  <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z" /></svg>
                )}
              </button>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-semibold">{sound.title}</span>
                <span className="truncate text-xs text-muted">
                  {[sound.artist, seconds(sound.durationMs)].filter(Boolean).join(" · ")}
                </span>
              </span>
              <button
                type="button"
                onClick={() => {
                  onChange({
                    id: sound.id,
                    title: sound.title,
                    audioVolume: value?.audioVolume ?? 100,
                    videoVolume: value?.videoVolume ?? 1,
                  });
                  setOpen(false);
                }}
                className="press min-h-9 shrink-0 rounded-full bg-accent px-3 text-[13px] font-semibold text-white hover:bg-accent-hover"
              >
                Use
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
