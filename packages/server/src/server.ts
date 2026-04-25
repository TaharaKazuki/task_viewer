import { serve } from '@hono/node-server';
import {
  type TodoFileEvent,
  watchJsonlTodos,
  watchSessionMeta,
  watchTodos,
} from '@task-viewer/core';
import { createApp } from './app.js';
import { EventBus } from './bus.js';
import { type EnrichedTodoFileEvent, type TodoSource, enrich } from './enrich.js';
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
  const jsonlTodoWatcher = watchJsonlTodos(
    opts.projectsDir ? { dir: opts.projectsDir } : undefined,
  );

  // Pump session metadata → SessionIndex. On late discovery re-emit upserts
  // for matching state entries (covers todos/-only sessions whose JSONL
  // arrives after their first upsert).
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
          source: snap.source,
        };
        state.apply(enriched);
        bus.publish(enriched);
      }
    }
  })();
  sessionPump.catch((err: unknown) => {
    console.error('[task-viewer/server] session pump failed:', toError(err));
  });

  // A pump that processes a TodoFileEvent stream and tags each event with
  // the source of origin. Used twice: once for ~/.claude/todos/ events
  // (source='todos') and once for JSONL-derived events (source='jsonl').
  const makeTodoPump = (
    iter: AsyncIterable<TodoFileEvent>,
    source: TodoSource,
  ): { promise: Promise<void> } => {
    const promise = (async () => {
      for await (const ev of iter) {
        const info = ev.kind === 'upsert' ? sessionIndex.get(ev.meta.sessionId) : null;
        const enriched: EnrichedTodoFileEvent =
          ev.kind === 'upsert' ? enrich(ev, info, source) : ev;
        state.apply(enriched);
        bus.publish(enriched);
      }
    })();
    return { promise };
  };

  const todoPump = makeTodoPump(todoWatcher.events, 'todos');
  const jsonlPump = makeTodoPump(jsonlTodoWatcher.events, 'jsonl');

  // On either pump's terminal failure: surface as an error event and close
  // the bus so SSE clients disconnect (their EventSource will reconnect).
  const installPumpFailureHandler = (p: Promise<void>): void => {
    p.catch((err: unknown) => {
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
  };
  installPumpFailureHandler(todoPump.promise);
  installPumpFailureHandler(jsonlPump.promise);

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
    bus.closeAll();
    await Promise.all([todoWatcher.stop(), sessionWatcher.stop(), jsonlTodoWatcher.stop()]);
    await Promise.all([
      todoPump.promise.catch(() => undefined),
      jsonlPump.promise.catch(() => undefined),
      sessionPump.catch(() => undefined),
    ]);
    throw err;
  }

  const address = httpServer.address();
  const port = typeof address === 'object' && address !== null ? address.port : requestedPort;

  return {
    port,
    async close() {
      bus.closeAll();
      await Promise.all([todoWatcher.stop(), sessionWatcher.stop(), jsonlTodoWatcher.stop()]);
      await Promise.all([
        todoPump.promise.catch(() => undefined),
        jsonlPump.promise.catch(() => undefined),
        sessionPump.catch(() => undefined),
      ]);
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
