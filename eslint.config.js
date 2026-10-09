import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const nodeGlobals = {
  console: 'readonly',
  process: 'readonly',
  Buffer: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  // Node 18+ 全局（脚本使用 fetch/AbortController；P06-01 能力核验工具）
  fetch: 'readonly',
  AbortController: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      // 临时浏览器/媒体证据与探针，已由 Git 忽略，不作为项目源码检查。
      '.artifacts/**',
      '**/*.tsbuildinfo',
      '.github/**',
      // Next.js 生成物（P05-03：apps/web 的构建缓存与自动生成声明）
      '**/.next/**',
      '**/next-env.d.ts',
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
