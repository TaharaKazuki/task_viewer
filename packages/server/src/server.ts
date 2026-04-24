import { serve } from '@hono/node-server';
import { type TodoFileEvent, watchTodos } from '@task-viewer/core';
import { createApp } from './app.js';
import { EventBus } from './bus.js';
import { StateStore } from './state.js';

export type StartServerOptions = {
  port?: number;
  host?: string;
  dir?: string;
  corsOrigin?: string | string[];
  heartbeatMs?: number;
};

export type RunningServer = {
  port: number;
  close: () => Promise<void>;
};

const toError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

export async function startServer(opts: StartServerOptions = {}): Promise<RunningServer> {
  const requestedPort = opts.port ?? 4321;
  const host = opts.host ?? '127.0.0.1';

  const state = new StateStore();
  const bus = new EventBus<TodoFileEvent>();
  const watcher = watchTodos(opts.dir ? { dir: opts.dir } : undefined);

  // Pump watcher → state + bus. Runs for the life of the server. On failure,
  // publish a synthetic error event and close the bus so SSE clients
  // disconnect cleanly (EventSource will then auto-reconnect and get a fresh
  // snapshot from a new server process if the operator restarted us).
  const pump = (async () => {
    for await (const ev of watcher.events) {
      state.apply(ev);
      bus.publish(ev);
    }
  })();
  pump.catch((err: unknown) => {
    const e = toError(err);
    console.error('[task-viewer/server] watcher pump failed:', e);
    try {
      bus.publish({
        kind: 'error',
        path: opts.dir ?? '(default)',
        reason: 'io',
        error: e,
      });
    } finally {
      bus.closeAll();
    }
  });

  const app = createApp({
    state,
    bus,
    ...(opts.corsOrigin !== undefined && { corsOrigin: opts.corsOrigin }),
    ...(opts.heartbeatMs !== undefined && { heartbeatMs: opts.heartbeatMs }),
  });

  let httpServer: ReturnType<typeof serve>;
  try {
    httpServer = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
      const s = serve({ fetch: app.fetch, port: requestedPort, hostname: host }, () => resolve(s));
      s.on('error', (err) => reject(err));
    });
  } catch (err) {
    // Roll back partial setup so the caller doesn't leak a watcher on EADDRINUSE.
    bus.closeAll();
    await watcher.stop();
    await pump.catch(() => undefined);
    throw err;
  }

  const address = httpServer.address();
  const port = typeof address === 'object' && address !== null ? address.port : requestedPort;

  return {
    port,
    async close() {
      bus.closeAll();
      await watcher.stop();
      await pump.catch(() => undefined);
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
