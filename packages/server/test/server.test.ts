import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type RunningServer, startServer } from '../src/server.js';

const UUID_A = '01205cda-ff84-4259-9f77-8e898c0cf748';
const fname = (sid: string, aid: string) => `${sid}-agent-${aid}.json`;

type SSEMessage = { event: string; data: string };

function parseSSE(raw: string): SSEMessage {
  let event = '';
  let data = '';
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trimStart();
  }
  return { event, data };
}

async function readSSEMessage(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: InstanceType<typeof TextDecoder>,
  buffer: { text: string },
  timeoutMs = 2000,
): Promise<SSEMessage | null> {
  const deadline = Date.now() + timeoutMs;
  while (!buffer.text.includes('\n\n')) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('SSE read timeout');
    const timeoutP = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('SSE read timeout')), remaining),
    );
    const { value, done } = await Promise.race([reader.read(), timeoutP]);
    if (done) return null;
    buffer.text += decoder.decode(value, { stream: true });
  }
  const idx = buffer.text.indexOf('\n\n');
  const raw = buffer.text.slice(0, idx);
  buffer.text = buffer.text.slice(idx + 2);
  return parseSSE(raw);
}

describe('startServer (integration: real @hono/node-server + real chokidar)', () => {
  let dir: string;
  let server: RunningServer | null = null;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'tv-server-')));
  });

  afterEach(async () => {
    if (server) await server.close();
    server = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves healthz on an ephemeral port', async () => {
    server = await startServer({ dir, port: 0 });
    const res = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('streams snapshot then a live upsert over SSE end-to-end', async () => {
    writeFileSync(
      path.join(dir, fname(UUID_A, UUID_A)),
      JSON.stringify([{ id: '1', content: 'initial', status: 'pending' }]),
    );
    server = await startServer({ dir, port: 0 });

    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${server.port}/events`, {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);

    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const buf = { text: '' };

    // Snapshot may be empty (initial scan still running) or already contain
    // the file. Either way, the `ready` event confirms the initial scan is done.
    const snapshot = await readSSEMessage(reader, decoder, buf);
    expect(snapshot?.event).toBe('snapshot');

    // After snapshot we should receive either a live upsert (if the file was
    // not in snapshot yet) or a ready. Collect until we have seen 'ready'.
    let sawUpsertForInitial = JSON.parse(snapshot?.data ?? '{}').files.length > 0;
    let sawReady = false;
    while (!sawReady) {
      const msg = await readSSEMessage(reader, decoder, buf, 3000);
      if (!msg) break;
      if (msg.event === 'upsert') {
        const payload = JSON.parse(msg.data);
        if (payload.items[0]?.content === 'initial') sawUpsertForInitial = true;
      } else if (msg.event === 'ready') {
        sawReady = true;
      }
    }
    expect(sawReady).toBe(true);
    expect(sawUpsertForInitial).toBe(true);

    // Now inject a live write and expect an upsert event.
    writeFileSync(
      path.join(dir, fname(UUID_A, UUID_A)),
      JSON.stringify([{ id: '1', content: 'updated', status: 'completed' }]),
    );
    let liveUpdate: SSEMessage | null = null;
    for (let i = 0; i < 5; i++) {
      const msg = await readSSEMessage(reader, decoder, buf, 3000);
      if (!msg) break;
      if (msg.event === 'upsert') {
        const payload = JSON.parse(msg.data);
        if (payload.items[0]?.content === 'updated') {
          liveUpdate = msg;
          break;
        }
      }
    }
    expect(liveUpdate).not.toBeNull();

    controller.abort();
  });

  it('rejects and cleans up if the requested port is already in use', async () => {
    const s1 = await startServer({ dir, port: 0, heartbeatMs: 0 });
    try {
      await expect(startServer({ dir, port: s1.port, heartbeatMs: 0 })).rejects.toThrow();
    } finally {
      await s1.close();
    }
  });
});
