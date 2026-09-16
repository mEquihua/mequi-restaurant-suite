import { createApp } from './app.js';

const app = createApp();
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

async function start() {
  try {
    const address = await app.listen({ port, host });
    app.log.info({ address }, 'API started');
  } catch (error) {
    app.log.error(error, 'API failed to start');
    process.exitCode = 1;
  }
}

void start();
