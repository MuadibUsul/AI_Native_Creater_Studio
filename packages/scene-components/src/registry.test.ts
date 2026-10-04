import { describe, expect, it } from 'vitest';
import { STANDARD_SCENE_TYPES } from '@ancs/contracts';
import {
  componentCatalog,
  getComponent,
  listComponents,
  missingStandardComponents,
  registerComponent,
  resetRegistryForTesting,
} from './registry.js';
import { registerBuiltInComponents, resetBuiltInFlagForTesting } from './builtin.js';
import { bigNumberComponent } from './components/big-number.js';
import { defineComponent } from './protocol.js';

/**
 * P05-01 单元验收（注册表语义）：
 * - 注册即协议自检（坏组件拒绝）；重复 (type, version) 拒绝；
 * - 版本解析：精确匹配与"最高版本"；多版本共存（历史 Scene.componentVersion 可渲染）；
 * - `missingStandardComponents()` 暴露 V1 20 类的**进展**（P05-02 必须为空）。
 */

const reRegisterBuiltins = (): void => {
  resetRegistryForTesting();
  resetBuiltInFlagForTesting();
  registerBuiltInComponents();
};

describe('组件注册表', () => {
  it('内置装配：BIG_NUMBER 可用，目录条目可序列化', () => {
    reRegisterBuiltins();
    const bigNumber = getComponent('BIG_NUMBER');
    expect(bigNumber?.version).toBe('1.0.0');
    expect(componentCatalog().some((entry) => entry.type === 'BIG_NUMBER')).toBe(true);
    // 每项目录条目都带 fixture（可直接渲染验收）
    for (const entry of componentCatalog()) {
      expect(entry.fixture.durationMs).toBeGreaterThan(0);
    }
  });

  it('坏组件与重复注册被明确拒绝', () => {
    reRegisterBuiltins();
    expect(() => registerComponent({ ...bigNumberComponent, version: 'nope' })).toThrow(/未通过协议校验/);
    expect(() => registerComponent(bigNumberComponent)).toThrow(/重复注册/);
  });

  it('同类型多版本共存：精确匹配与最高版本解析', () => {
    reRegisterBuiltins();
    const v2 = defineComponent({ ...bigNumberComponent, version: '2.0.0', title: '大字报数 v2' });
    registerComponent({ ...v2, version: '2.0.0' });
    expect(getComponent('BIG_NUMBER', '1.0.0')?.version).toBe('1.0.0');
    expect(getComponent('BIG_NUMBER', '2.0.0')?.title).toBe('大字报数 v2');
    expect(getComponent('BIG_NUMBER')?.version).toBe('2.0.0'); // 省略版本 → 最高
    expect(getComponent('BIG_NUMBER', '3.0.0')).toBeNull();
    expect(getComponent('NOT_REGISTERED')).toBeNull();
    expect(listComponents().filter((definition) => definition.type === 'BIG_NUMBER').length).toBe(2);
    reRegisterBuiltins();
  });

  it('missingStandardComponents 暴露 20 类进展（P05-01 尚缺 19；P05-02 必须为空）', () => {
    reRegisterBuiltins();
    const missing = missingStandardComponents();
    expect(missing.length).toBe(STANDARD_SCENE_TYPES.length - 1);
    expect(missing).not.toContain('BIG_NUMBER');
  });
});
