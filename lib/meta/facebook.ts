/**
 * Facebook Login for Business (graph.facebook.com).
 *
 * One login yields a Page token that does not expire. That token publishes
 * Instagram Reels for the Page's linked Instagram account (including licensed
 * sounds from the Audio API) and Reels to the Page itself.
 */

import { getMetaGraphApiVersion, requireEnv } from "@/lib/env";
import { handleResponse } from "@/lib/meta/client";

const version = () => getMetaGraphApiVersion();
const base = () => `https://graph.facebook.com/${version()}`;

/** Permissions requested when no Business Login configuration is set. */
export const FACEBOOK_SCOPES = [
  "instagram_basic",
  "instagram_content_publish",
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
];

export function getFacebookAuthorizationUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: requireEnv("FACEBOOK_APP_ID"),
    redirect_uri: redirectUri,
    state,
    response_type: "code",
  });
  // Meta recommends a Business Login configuration (config_id) over scope.
  const configId = process.env.FACEBOOK_LOGIN_CONFIG_ID?.trim();
  if (configId) params.set("config_id", configId);
  else params.set("scope", FACEBOOK_SCOPES.join(","));
  return `https://www.facebook.com/${version()}/dialog/oauth?${params.toString()}`;
}

export async function exchangeFacebookCode(code: string, redirectUri: string): Promise<string> {
  const url = new URL(`${base()}/oauth/access_token`);
  url.searchParams.set("client_id", requireEnv("FACEBOOK_APP_ID"));
  url.searchParams.set("client_secret", requireEnv("FACEBOOK_APP_SECRET"));
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code", code);
  const data = await handleResponse<{ access_token: string }>(await fetch(url.toString()));
  return data.access_token;
}

/** Long-lived user token, about 60 days. Page tokens derived from it do not expire. */
export async function getLongLivedFacebookToken(
  shortLivedToken: string
): Promise<{ accessToken: string; expiresIn: number | null }> {
  const url = new URL(`${base()}/oauth/access_token`);
  url.searchParams.set("grant_type", "fb_exchange_token");
  url.searchParams.set("client_id", requireEnv("FACEBOOK_APP_ID"));
  url.searchParams.set("client_secret", requireEnv("FACEBOOK_APP_SECRET"));
  url.searchParams.set("fb_exchange_token", shortLivedToken);
  const data = await handleResponse<{ access_token: string; expires_in?: number }>(
    await fetch(url.toString())
  );
  return { accessToken: data.access_token, expiresIn: data.expires_in ?? null };
}

export interface FacebookPageWithInstagram {
  id: string;
  name: string;
  access_token: string;
  instagram_business_account?: { id: string; username?: string };
}

export async function listPagesWithInstagram(userToken: string): Promise<FacebookPageWithInstagram[]> {
  const url = new URL(`${base()}/me/accounts`);
  url.searchParams.set("fields", "id,name,access_token,instagram_business_account{id,username}");
  url.searchParams.set("limit", "100");
  url.searchParams.set("access_token", userToken);
  const data = await handleResponse<{ data: FacebookPageWithInstagram[] }>(await fetch(url.toString()));
  return data.data ?? [];
}

// ─── Instagram Audio API ─────────────────────────────────────────────────────

export type AudioType = "music" | "original_sound";

export interface InstagramAudio {
  audio_id: string;
  title?: string;
  duration_in_ms?: number;
  audio_type?: AudioType;
  download_url?: string;
  on_platform_audio_preview_link?: string;
  display_artist?: string;
  ig_username?: string;
  cover_artwork_thumbnail_uri?: string;
  cover_artwork_thumbnail_url?: string;
}

/** With no query Meta returns what is trending. */
export async function searchInstagramAudio(
  instagramUserId: string,
  accessToken: string,
  options: { type: AudioType; query?: string }
): Promise<InstagramAudio[]> {
  const url = new URL(`${base()}/ig_audio`);
  url.searchParams.set("audio_type", options.type);
  url.searchParams.set("user_id", instagramUserId);
  if (options.query) url.searchParams.set("search_query", options.query);
  url.searchParams.set("access_token", accessToken);
  const data = await handleResponse<{ data?: InstagramAudio[] }>(await fetch(url.toString()));
  return data.data ?? [];
}

// ─── Facebook Page Reels ─────────────────────────────────────────────────────

/**
 * Publishes a Reel to a Page from a public video URL: start an upload, let
 * Facebook fetch the file, then finish with video_state=PUBLISHED. Returns the
 * video id; processing continues afterwards (see getPageVideoStatus).
 */
export async function publishPageReelFromUrl(
  pageId: string,
  pageToken: string,
  input: { videoUrl: string; description?: string }
): Promise<string> {
  const start = await handleResponse<{ video_id: string; upload_url?: string }>(
    await fetch(`${base()}/${pageId}/video_reels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ upload_phase: "start", access_token: pageToken }),
    })
  );

  const uploadUrl =
    start.upload_url ?? `https://rupload.facebook.com/video-upload/${version()}/${start.video_id}`;
  await handleResponse<{ success?: boolean }>(
    await fetch(uploadUrl, {
      method: "POST",
      headers: { Authorization: `OAuth ${pageToken}`, file_url: input.videoUrl },
    })
  );

  const finish = new URL(`${base()}/${pageId}/video_reels`);
  finish.searchParams.set("upload_phase", "finish");
  finish.searchParams.set("video_id", start.video_id);
  finish.searchParams.set("video_state", "PUBLISHED");
  if (input.description) finish.searchParams.set("description", input.description);
  finish.searchParams.set("access_token", pageToken);
  await handleResponse(await fetch(finish.toString(), { method: "POST" }));

  return start.video_id;
}

export interface PageVideoStatus {
  video_status?: string;
  processing_phase?: { status?: string; error?: { message?: string } };
  publishing_phase?: { status?: string; publish_status?: string };
  uploading_phase?: { status?: string; errors?: { message?: string }[] };
}

export async function getPageVideoStatus(videoId: string, pageToken: string): Promise<PageVideoStatus> {
  const url = new URL(`${base()}/${videoId}`);
  url.searchParams.set("fields", "status");
  url.searchParams.set("access_token", pageToken);
  const data = await handleResponse<{ status?: PageVideoStatus }>(await fetch(url.toString()));
  return data.status ?? {};
}

export async function getPageVideoPermalink(videoId: string, pageToken: string): Promise<string | null> {
  const url = new URL(`${base()}/${videoId}`);
  url.searchParams.set("fields", "permalink_url");
  url.searchParams.set("access_token", pageToken);
  const data = await handleResponse<{ permalink_url?: string }>(await fetch(url.toString()));
  if (!data.permalink_url) return null;
  return data.permalink_url.startsWith("http")
    ? data.permalink_url
    : `https://www.facebook.com${data.permalink_url}`;
}
