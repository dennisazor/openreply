/**
 * Threads API (graph.threads.net). Its own OAuth app ID and secret, separate
 * from the Instagram ones. Tokens last 60 days and are renewed early by
 * lib/meta/token-refresh.ts.
 */

import { requireEnv } from "@/lib/env";
import { handleResponse } from "@/lib/meta/client";

const GRAPH = "https://graph.threads.net";
const API = `${GRAPH}/v1.0`;

export const THREADS_SCOPES = ["threads_basic", "threads_content_publish"];
/** Threads caps post text at 500 characters. */
export const THREADS_TEXT_LIMIT = 500;

export function getThreadsAuthorizationUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: requireEnv("THREADS_APP_ID"),
    redirect_uri: redirectUri,
    scope: THREADS_SCOPES.join(","),
    response_type: "code",
    state,
  });
  // Meta's current docs use threads.com (threads.net redirects there).
  return `https://threads.com/oauth/authorize?${params.toString()}`;
}

export async function exchangeThreadsCode(
  code: string,
  redirectUri: string
): Promise<{ accessToken: string; userId: string }> {
  const body = new URLSearchParams({
    client_id: requireEnv("THREADS_APP_ID"),
    client_secret: requireEnv("THREADS_APP_SECRET"),
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    code,
  });
  const data = await handleResponse<{ access_token: string; user_id: string | number }>(
    await fetch(`${GRAPH}/oauth/access_token`, { method: "POST", body })
  );
  return { accessToken: data.access_token, userId: String(data.user_id) };
}

export async function getLongLivedThreadsToken(
  shortLivedToken: string
): Promise<{ accessToken: string; expiresIn: number }> {
  const url = new URL(`${GRAPH}/access_token`);
  url.searchParams.set("grant_type", "th_exchange_token");
  url.searchParams.set("client_secret", requireEnv("THREADS_APP_SECRET"));
  url.searchParams.set("access_token", shortLivedToken);
  const data = await handleResponse<{ access_token: string; expires_in?: number }>(
    await fetch(url.toString())
  );
  return { accessToken: data.access_token, expiresIn: data.expires_in ?? 5184000 };
}

export async function refreshThreadsToken(
  token: string
): Promise<{ accessToken: string; expiresIn: number }> {
  const url = new URL(`${GRAPH}/refresh_access_token`);
  url.searchParams.set("grant_type", "th_refresh_token");
  url.searchParams.set("access_token", token);
  const data = await handleResponse<{ access_token: string; expires_in?: number }>(
    await fetch(url.toString())
  );
  return { accessToken: data.access_token, expiresIn: data.expires_in ?? 5184000 };
}

export async function getThreadsProfile(token: string): Promise<{ id: string; username: string }> {
  const url = new URL(`${API}/me`);
  url.searchParams.set("fields", "id,username");
  url.searchParams.set("access_token", token);
  return handleResponse(await fetch(url.toString()));
}

/** Creates a video post container; Threads fetches the file from videoUrl. */
export async function createThreadsVideo(
  threadsUserId: string,
  token: string,
  input: { videoUrl: string; text?: string }
): Promise<{ id: string }> {
  const body = new URLSearchParams({
    media_type: "VIDEO",
    video_url: input.videoUrl,
    access_token: token,
  });
  if (input.text) body.set("text", input.text);
  return handleResponse(await fetch(`${API}/${threadsUserId}/threads`, { method: "POST", body }));
}

export async function getThreadsContainerStatus(
  containerId: string,
  token: string
): Promise<{ status: "IN_PROGRESS" | "FINISHED" | "ERROR" | "EXPIRED" | "PUBLISHED"; error_message?: string }> {
  const url = new URL(`${API}/${containerId}`);
  url.searchParams.set("fields", "status,error_message");
  url.searchParams.set("access_token", token);
  return handleResponse(await fetch(url.toString()));
}

export async function publishThreads(
  threadsUserId: string,
  token: string,
  containerId: string
): Promise<{ id: string }> {
  const body = new URLSearchParams({ creation_id: containerId, access_token: token });
  return handleResponse(
    await fetch(`${API}/${threadsUserId}/threads_publish`, { method: "POST", body })
  );
}

export async function getThreadsPermalink(mediaId: string, token: string): Promise<string | null> {
  const url = new URL(`${API}/${mediaId}`);
  url.searchParams.set("fields", "permalink");
  url.searchParams.set("access_token", token);
  const data = await handleResponse<{ permalink?: string }>(await fetch(url.toString()));
  return data.permalink ?? null;
}
