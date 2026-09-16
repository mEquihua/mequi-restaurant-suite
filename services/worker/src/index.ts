import { OutboxDispatcher } from './dispatcher.js';

const dbUrl = process.env.DATABASE_URL;
const redisUrl = process.env.VALKEY_URL || process.env.REDIS_URL || 'redis://valkey:6379';

if (!dbUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const dispatcher = new OutboxDispatcher({ dbUrl, redisUrl });

async function stop(signal: NodeJS.Signals) {
  console.info({ signal }, 'worker stopping');
  await dispatcher.stop();
  process.exit(0);
}

console.info('worker started');
dispatcher.start();

process.once('SIGTERM', () => stop('SIGTERM'));
process.once('SIGINT', () => stop('SIGINT'));
