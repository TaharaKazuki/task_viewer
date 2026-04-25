import { serve } from '@hono/node-server';
import { type TodoFileEvent, watchSessionMeta, watchTodos } from '@task-viewer/core';
import { createApp } from './app.js';
import { EventBus } from './bus.js';
import { type EnrichedTodoFileEvent, enrich } from './enrich.js';
import { SessionIndex } from './sessionIndex.js';
import { StateStore } from './state.js';

export type StartServerOptions = {
  port?: number;
  host?: string;
  dir?: string; // ~/.claude/todos override
  projectsDir?: string; // ~/.claude/projects override
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
  const bus = new EventBus<EnrichedTodoFileEvent>();
  const sessionIndex = new SessionIndex();

  const todoWatcher = watchTodos(opts.dir ? { dir: opts.dir } : undefined);
  const sessionWatcher = watchSessionMeta(opts.projectsDir ? { dir: opts.projectsDir } : undefined);

  // Pump session metadata → SessionIndex. When a session is discovered AFTER
  // its todo file was already registered in state, re-emit enriched upserts
  // for every matching state entry so clients pick up the project label.
  // Uses the inverted `pathsForSession` index to stay O(k) instead of
  // scanning the entire state every discovered event.
  const sessionPump = (async () => {
    for await (const ev of sessionWatcher.events) {
      const result = sessionIndex.apply(ev);
      if (ev.kind !== 'discovered') continue;
      if (!result.changed) continue;
      const info = sessionIndex.get(ev.sessionId);
      if (!info) continue;
      for (const snap of state.pathsForSession(ev.sessionId)) {
        if (snap.project === info.project && snap.cwd === info.cwd) continue;
        const enriched: EnrichedTodoFileEvent = {
          kind: 'upsert',
          meta: snap.meta,
          path: snap.path,
          items: [...snap.items],
          mtimeMs: snap.mtimeMs,
          cwd: info.cwd,
          gitBranch: info.gitBranch,
          project: info.project,
        };
        state.apply(enriched);
        bus.publish(enriched);
      }
    }
  })();
  sessionPump.catch((err: unknown) => {
    console.error('[task-viewer/server] session pump failed:', toError(err));
  });

  // Pump todo events with enrichment → state + bus.
  const todoPump = (async () => {
    for await (const ev of todoWatcher.events) {
      const info = ev.kind === 'upsert' ? sessionIndex.get(ev.meta.sessionId) : null;
      const enriched: EnrichedTodoFileEvent =
        ev.kind === 'upsert' ? enrich(ev as TodoFileEvent, info) : ev;
      state.apply(enriched);
      bus.publish(enriched);
    }
  })();
  todoPump.catch((err: unknown) => {
    const e = toError(err);
    console.error('[task-viewer/server] todo pump failed:', e);
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
    // Roll back partial setup so the caller doesn't leak watchers on EADDRINUSE.
    bus.closeAll();
    await Promise.all([todoWatcher.stop(), sessionWatcher.stop()]);
    await Promise.all([todoPump.catch(() => undefined), sessionPump.catch(() => undefined)]);
    throw err;
  }

  const address = httpServer.address();
  const port = typeof address === 'object' && address !== null ? address.port : requestedPort;

  return {
    port,
    async close() {
      bus.closeAll();
      await Promise.all([todoWatcher.stop(), sessionWatcher.stop()]);
      await Promise.all([todoPump.catch(() => undefined), sessionPump.catch(() => undefined)]);
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
