import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

/** RTL 清理（未启用 vitest globals；每个测试文件独立清理 DOM）。 */
afterEach(() => {
  cleanup();
});
