import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import type { EventBus } from './bus.js';
import type { EnrichedTodoFileEvent } from './enrich.js';
import type { StateStore } from './state.js';

export type CreateAppDeps = {
  state: StateStore;
  bus: EventBus<EnrichedTodoFileEvent>;
  // CORS allowlist. Default: Vite dev defaults. Using `*` would let any
  // webpage on this machine read the user's todo contents — restrict.
  corsOrigin?: string | string[];
  // Heartbeat comment interval. 0 disables. Default 20_000ms keeps
  // idle SSE streams alive across proxy/NAT idle timeouts.
  heartbeatMs?: number;
  // Reconnect retry hint sent to the EventSource client. Default 3_000ms.
  retryMs?: number;
};

type SSEPayload = { event: string; data: string };

function toSSEPayload(ev: EnrichedTodoFileEvent): SSEPayload {
  if (ev.kind === 'upsert') {
    return {
      event: 'upsert',
      data: JSON.stringify({
        meta: ev.meta,
        path: ev.path,
        items: ev.items,
        mtimeMs: ev.mtimeMs,
        cwd: ev.cwd,
        gitBranch: ev.gitBranch,
        project: ev.project,
        source: ev.source,
      }),
    };
  }
  if (ev.kind === 'remove') {
    return {
      event: 'remove',
      data: JSON.stringify({ meta: ev.meta, path: ev.path }),
    };
  }
  if (ev.kind === 'error') {
    return {
      event: 'error',
      data: JSON.stringify({
        path: ev.path,
        reason: ev.reason,
        // Message only — stack leaks absolute paths and internal details
        // (ADR-0002 §6).
        message: ev.error.message,
      }),
    };
  }
  return { event: 'ready', data: '{}' };
}

const DEFAULT_CORS_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

export function createApp({
  state,
  bus,
  corsOrigin,
  heartbeatMs = 20_000,
  retryMs = 3_000,
}: CreateAppDeps): Hono {
  const app = new Hono();
  const origin = corsOrigin ?? DEFAULT_CORS_ORIGINS;
  app.use('*', cors({ origin, credentials: false }));

  app.get('/healthz', (c) => c.text('ok'));

  app.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      // Subscribe BEFORE snapshot to close the lossy window where a pump
      // iteration lands between snapshot emission and subscribe registration.
      // Over-delivering a live upsert for a file already in snapshot is
      // idempotent under path-keyed client state.
      const sub = bus.subscribe();
      stream.onAbort(() => sub.unsubscribe());

      await stream.writeSSE({
        event: 'snapshot',
        data: JSON.stringify({ files: state.snapshot() }),
        retry: retryMs,
      });

      let heartbeat: ReturnType<typeof setInterval> | undefined;
      if (heartbeatMs > 0) {
        heartbeat = setInterval(() => {
          // ": ..." is an SSE comment line — clients ignore it, but the
          // bytes keep intermediary idle timers from closing the stream.
          void stream.write(': heartbeat\n\n').catch(() => {
            // Client disconnected; onAbort will handle full cleanup.
          });
        }, heartbeatMs);
      }

      try {
        for await (const ev of sub.events) {
          await stream.writeSSE(toSSEPayload(ev));
        }
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        sub.unsubscribe();
      }
    }),
  );

  return app;
}
