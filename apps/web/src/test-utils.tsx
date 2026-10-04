import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { AncsApiError, type AncsClient } from '@ancs/sdk';
import { Providers } from '@/app/providers';

/**
 * 测试工具（P05-03）：脚本化 SDK 客户端（vi.fn）注入 Providers；
 * 不 mock 组件协议与业务契约——状态矩阵断言针对真实组件行为。
 */

export function renderWithClient(ui: ReactElement, client: AncsClient): RenderResult {
  return render(<Providers client={client}>{ui}</Providers>);
}

type Mocked = Record<string, unknown>;

/** 深合并式构造 mock 客户端：未提供的命名空间/方法在访问时抛出（避免静默未 mock 的调用）。 */
export function mockClient(overrides: Mocked): AncsClient {
  return new Proxy(overrides, {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      throw new Error(`测试未 mock 的 SDK 成员：${String(prop)}`);
    },
  }) as unknown as AncsClient;
}

export const apiError = (status: number, code: string, message = 'mock error', details: Record<string, unknown> = {}): AncsApiError =>
  new AncsApiError({ status, code, message, requestId: 'req_test', details });

/**
 * 测试文件（jsdom 的 File 未实现 arrayBuffer/text —— 产品代码使用标准 Web API，
 * 这里在测试环境补齐该能力，避免为了 jsdom 在产品代码里加回退分支）。
 */
export function testFile(name: string, content: string, type: string): File {
  const file = new File([content], name, { type });
  if (typeof file.arrayBuffer !== 'function') {
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => new TextEncoder().encode(content).buffer,
      configurable: true,
    });
  }
  return file;
}

export const okJson = <T,>(value: T) => value;
