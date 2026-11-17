/**
 * Slack Socket Mode watchdog (fork customization, not upstream).
 *
 * @slack/socket-mode reconnects on its own, but when a reconnect's start()
 * rejects (e.g. apps.connections.open keeps failing), the rejection is
 * unhandled and no further retry is scheduled. The host logs unhandled
 * rejections and keeps running, so the process stays up but deaf to inbound
 * Slack events while outbound REST calls (chat.postMessage) keep working —
 * the Aug 2026 outage. This watchdog exits the process when any Socket Mode
 * client has been disconnected for longer than the grace period, so systemd
 * (Restart=always) starts a fresh process with a new socket.
 *
 * Lives in its own file (imported from the channel barrel) so refreshing the
 * upstream Slack payload (/add-slack) doesn't overwrite it.
 */
import { SocketModeClient } from '@slack/socket-mode';

import { log } from '../log.js';

const GRACE_MS = Number(process.env.SLACK_SOCKET_WATCHDOG_GRACE_MS) || 5 * 60 * 1000;
const CHECK_INTERVAL_MS = 30 * 1000;

interface Tracked {
  connected: boolean;
  downSince: number | null;
}

const tracked = new Map<SocketModeClient, Tracked>();
let timer: NodeJS.Timeout | null = null;

function isShuttingDown(client: SocketModeClient): boolean {
  return (client as unknown as { shuttingDown?: boolean }).shuttingDown === true;
}

function track(client: SocketModeClient): void {
  if (tracked.has(client)) return;
  const state: Tracked = { connected: false, downSince: Date.now() };
  tracked.set(client, state);
  client.on('connected', () => {
    state.connected = true;
    state.downSince = null;
  });
  const markDown = () => {
    if (state.connected || state.downSince === null) state.downSince = Date.now();
    state.connected = false;
  };
  client.on('reconnecting', markDown);
  client.on('disconnected', markDown);
  client.on('close', markDown);
  if (!timer) {
    timer = setInterval(check, CHECK_INTERVAL_MS);
    timer.unref();
  }
}

export function check(now = Date.now()): void {
  for (const [client, state] of tracked) {
    if (isShuttingDown(client)) {
      tracked.delete(client);
      continue;
    }
    if (!state.connected && state.downSince !== null && now - state.downSince > GRACE_MS) {
      log.fatal('Slack Socket Mode disconnected beyond grace period, exiting for restart', {
        downForMs: now - state.downSince,
        graceMs: GRACE_MS,
      });
      process.exit(1);
    }
  }
}

const proto = SocketModeClient.prototype as unknown as {
  start: (...args: unknown[]) => Promise<unknown>;
  __nanoclawWatchdog?: true;
};
if (!proto.__nanoclawWatchdog) {
  const originalStart = proto.start;
  proto.start = function (this: SocketModeClient, ...args: unknown[]) {
    track(this);
    return originalStart.apply(this, args);
  };
  proto.__nanoclawWatchdog = true;
}
