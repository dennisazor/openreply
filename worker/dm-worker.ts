import { createDMWorker } from "@/lib/queue/dm-worker";
import { recordWorkerHeartbeat } from "@/lib/ops/worker-health";
import { reconcileComments } from "@/lib/polling/comment-reconciler";
import { runPublishSweep } from "@/lib/publishing/publisher";
import { refreshAllExpiringTokens } from "@/lib/meta/token-refresh";
import os from "node:os";

const worker = createDMWorker();
const startedAt = new Date().toISOString();
const HEARTBEAT_INTERVAL_MS = 30_000;
// Polling safety net for comments that webhooks miss. Runs in the worker because
// it must fire every few minutes and Vercel's free crons only run once a day.
const POLL_INTERVAL_MS = Number(
  process.env.COMMENT_POLL_INTERVAL_MS ?? 5 * 60_000
);

console.log("[DM Worker] Started");

async function heartbeat() {
  try {
    await recordWorkerHeartbeat({
      pid: process.pid,
      hostname: os.hostname(),
      startedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Heartbeat failed:", message);
  }
}

void heartbeat();
const heartbeatTimer = setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL_MS);

async function poll() {
  try {
    await reconcileComments();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Comment reconciliation failed:", message);
  }
}

// Kick off one sweep shortly after boot, then on a fixed interval.
setTimeout(() => void poll(), 10_000);
const pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);

// Scheduled Reels. Once a minute matches Meta's container status polling
// guidance. The guard skips a tick while a slow sweep is still running.
const PUBLISH_INTERVAL_MS = 60_000;
let publishing = false;
async function publishSweep() {
  if (publishing) return;
  publishing = true;
  try {
    await runPublishSweep();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Publish sweep failed:", message);
  } finally {
    publishing = false;
  }
}
setTimeout(() => void publishSweep(), 15_000);
const publishTimer = setInterval(() => void publishSweep(), PUBLISH_INTERVAL_MS);

// Token renewal. The daily Vercel cron also runs it; doing it here too means
// one of them failing never lets an Instagram connection lapse.
const TOKEN_REFRESH_INTERVAL_MS = 6 * 60 * 60_000;
async function renewTokens() {
  try {
    const { instagram, threads } = await refreshAllExpiringTokens();
    const results = [...instagram, ...threads];
    const failed = results.filter((r) => r.status === "failed").length;
    if (results.length) {
      console.log(`[DM Worker] Token renewal: ${results.length - failed} renewed, ${failed} failed`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Token renewal failed:", message);
  }
}
setTimeout(() => void renewTokens(), 30_000);
const tokenTimer = setInterval(() => void renewTokens(), TOKEN_REFRESH_INTERVAL_MS);

async function shutdown(signal: string) {
  console.log(`[DM Worker] ${signal} received, closing worker`);
  clearInterval(heartbeatTimer);
  clearInterval(pollTimer);
  clearInterval(publishTimer);
  clearInterval(tokenTimer);
  await worker.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
