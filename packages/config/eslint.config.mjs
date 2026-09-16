import js from '@eslint/js';
import boundaries from 'eslint-plugin-boundaries';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

const apiBoundarySettings = {
  'import/resolver': {
    typescript: {
      project: ['./services/api/tsconfig.json'],
    },
  },
  'boundaries/elements': [
    {
      type: 'api-module',
      pattern: 'services/api/src/modules/*',
      mode: 'folder',
      capture: ['module'],
    },
    {
      type: 'api-module',
      pattern: 'services/api/lint-fixtures/*',
      mode: 'file',
      capture: ['module'],
    },
    { type: 'api-composition', pattern: 'services/api/src/app.ts', mode: 'file' },
    { type: 'api-composition', pattern: 'services/api/src/server.ts', mode: 'file' },
    { type: 'api-shared', pattern: 'services/api/src/shared', mode: 'folder' },
    { type: 'contracts', pattern: 'packages/contracts/src', mode: 'folder' },
    { type: 'domain', pattern: 'packages/domain/src', mode: 'folder' },
  ],
};

export default [
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'packages/contracts/src/generated/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['apps/**/*.{ts,tsx}', 'packages/ui-*/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  {
    files: ['services/api/**/*.ts'],
    plugins: { boundaries },
    settings: apiBoundarySettings,
    rules: {
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: [
            { from: 'api-module', allow: ['api-module', 'api-shared', 'contracts', 'domain'] },
            { from: 'api-shared', allow: ['api-shared', 'contracts', 'domain'] },
            {
              from: 'api-composition',
              allow: ['api-composition', 'api-module', 'api-shared', 'contracts', 'domain'],
            },
          ],
        },
      ],
      'boundaries/no-private': 'error',
      'boundaries/entry-point': [
        'error',
        {
          default: 'disallow',
          rules: [
            { target: 'api-module', allow: 'index.ts' },
            { target: 'api-composition', allow: ['app.ts', 'server.ts'] },
          ],
        },
      ],
    },
  },
];
