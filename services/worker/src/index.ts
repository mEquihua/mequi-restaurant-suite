const keepAlive = setInterval(() => undefined, 60_000);

function stop(signal: NodeJS.Signals) {
  clearInterval(keepAlive);
  console.info({ signal }, 'worker stopping');
  process.exit(0);
}

console.info('worker started');
process.once('SIGTERM', () => stop('SIGTERM'));
