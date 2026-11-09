/**
 * Sound search for the composer and the Claude connector (Instagram Audio API).
 * Needs the account's Facebook connection. Meta's docs disagree on whether a
 * Page token is accepted for /ig_audio, so the Page token is tried first and
 * the long-lived user token from the same login is the fallback.
 */

import { prisma } from "@/lib/db/client";
import { searchInstagramAudio, type AudioType, type InstagramAudio } from "@/lib/meta/facebook";
import { decryptToken } from "@/lib/meta/oauth";

export class SoundsUnavailableError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export interface SoundView {
  id: string;
  title: string;
  artist: string | null;
  type: AudioType | null;
  durationMs: number | null;
  previewUrl: string | null;
  instagramLink: string | null;
  cover: string | null;
}

function view(audio: InstagramAudio): SoundView {
  return {
    id: audio.audio_id,
    title: audio.title ?? "Untitled sound",
    artist: audio.display_artist ?? (audio.ig_username ? `@${audio.ig_username}` : null),
    type: audio.audio_type ?? null,
    durationMs: audio.duration_in_ms ?? null,
    previewUrl: audio.download_url ?? null,
    instagramLink: audio.on_platform_audio_preview_link ?? null,
    cover: audio.cover_artwork_thumbnail_url ?? audio.cover_artwork_thumbnail_uri ?? null,
  };
}

/** Trending sounds when there is no query. */
export async function findSounds(
  workspaceId: string,
  options: { type?: AudioType; query?: string; instagramAccountId?: string | null } = {}
): Promise<SoundView[]> {
  const account = await prisma.instagramAccount.findFirst({
    where: options.instagramAccountId
      ? { id: options.instagramAccountId, workspaceId }
      : { workspaceId },
    orderBy: { connectedAt: "desc" },
    select: { facebookIgUserId: true, facebookPageToken: true, facebookUserToken: true },
  });
  if (!account?.facebookIgUserId || !account.facebookPageToken) {
    throw new SoundsUnavailableError("Connect Facebook in Settings to browse sounds.", 409);
  }

  const tokens = [account.facebookPageToken, account.facebookUserToken].filter(
    (token): token is string => Boolean(token)
  );
  let lastError = "Could not load sounds.";
  for (const encrypted of tokens) {
    try {
      const results = await searchInstagramAudio(account.facebookIgUserId, decryptToken(encrypted), {
        type: options.type ?? "music",
        query: options.query?.trim().slice(0, 100) || undefined,
      });
      return results.map(view);
    } catch (error) {
      lastError = error instanceof Error ? error.message : lastError;
    }
  }
  throw new SoundsUnavailableError(
    `Instagram did not return sounds: ${lastError}. Try reconnecting Facebook.`,
    502
  );
}
