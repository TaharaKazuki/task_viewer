import { startServer } from './server.js';

const host = process.env.HOST ?? '127.0.0.1';
const port = process.env.PORT ? Number(process.env.PORT) : 4321;

try {
  const server = await startServer({ port, host });
  console.log(`[task-viewer/server] listening on http://${host}:${server.port}`);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[task-viewer/server] received ${signal}, shutting down…`);
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
} catch (err) {
  console.error('[task-viewer/server] failed to start:', err);
  process.exit(1);
}
