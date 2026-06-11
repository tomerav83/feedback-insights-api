import { buildServer } from './server';
import { config } from './config';

/**
 * Entrypoint: build the server, start listening, and wire graceful shutdown.
 * app.close() runs Fastify's onClose hooks, which later portions use to drain
 * and stop the in-process analysis worker.
 */
async function main(): Promise<void> {
  const app = buildServer();

  let closing = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error(err, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err, 'failed to start server');
    process.exit(1);
  }
}

void main();
