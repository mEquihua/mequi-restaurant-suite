function stop(signal: NodeJS.Signals) {
  console.info({ signal }, 'worker stopping');
  process.exit(0);
}

console.info('worker started');
process.once('SIGTERM', () => stop('SIGTERM'));
