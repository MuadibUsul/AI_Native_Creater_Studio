import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const nodeGlobals = {
  console: 'readonly',
  process: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
      '.github/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: nodeGlobals,
    },
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: nodeGlobals,
    },
    rules: {
      // 项目约定：下划线前缀 = 有意未使用（含 rest 解构中省略的属性）
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
);
