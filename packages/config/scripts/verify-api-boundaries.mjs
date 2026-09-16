import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const eslintBin = fileURLToPath(
  new URL('../../../node_modules/eslint/bin/eslint.js', import.meta.url),
);
const fixture = 'services/api/lint-fixtures/invalid-private-import.ts';

const result = spawnSync(process.execPath, [eslintBin, '--no-ignore', fixture], {
  cwd: root,
  encoding: 'utf8',
});

if (result.status === 0) {
  throw new Error(`Expected ${fixture} to fail the module-boundary lint rule.`);
}

if (!`${result.stdout}${result.stderr}`.includes('boundaries/')) {
  throw new Error(`Expected a boundaries lint error, received:\n${result.stdout}${result.stderr}`);
}

console.log('API module-boundary fixture correctly fails lint.');
