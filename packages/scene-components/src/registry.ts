import {
  COMPONENT_VALIDATION_REASONS,
  STANDARD_SCENE_TYPES,
  type ComponentCatalogEntry,
} from '@ancs/contracts';
import { toCatalogEntry, validateComponentDefinition, type ComponentDefinition } from './protocol.js';

/**
 * 组件注册表（P05-01 / 规范 §11.1、§4.3 不变量 8）。
 *
 * - 注册即**协议自检**（`validateComponentDefinition`）：不达标的组件抛错拒绝，不静默注册；
 * - 同名 (type, version) 重复注册 → 明确拒绝；
 * - 同一 type 可注册多个版本（历史 Scene.componentVersion 仍可解析渲染）；
 * - `missingStandardComponents()` 供 P05-02 断言 20 类齐全。
 */

const registry = new Map<string, Map<string, ComponentDefinition<unknown>>>();

/**
 * 类型擦除说明：注册表按 (type, version) 查找组件；props 的具体类型在**解析/渲染边界**由
 * 各组件自己的 inputSchema 保证（registry 只承载元数据与 renderer 引用，不消费 TProps）。
 */
export function registerComponent<TProps>(definition: ComponentDefinition<TProps>): void {
  const validation = validateComponentDefinition(definition);
  if (!validation.ok) {
    throw new Error(`组件 ${definition.type}@${definition.version} 未通过协议校验：${validation.messages.join('；')}`);
  }
  const versions = registry.get(definition.type) ?? new Map<string, ComponentDefinition<unknown>>();
  const erased = definition as ComponentDefinition<unknown>;
  if (versions.has(definition.version)) {
    throw new Error(
      `${definition.type}@${definition.version} 重复注册（${COMPONENT_VALIDATION_REASONS.DUPLICATE_TYPE_VERSION}）`,
    );
  }
  versions.set(definition.version, erased);
  registry.set(definition.type, versions);
}

const compareVersions = (left: string, right: string): number => {
  const parse = (value: string): number[] => value.split('.').map((part) => Number.parseInt(part, 10));
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

/** 解析组件定义：给定 version 精确匹配；省略 version → 取该 type 的最高版本。 */
export function getComponent(type: string, version?: string): ComponentDefinition<unknown> | null {
  const versions = registry.get(type);
  if (versions === undefined) return null;
  if (version !== undefined) return versions.get(version) ?? null;
  const latest = [...versions.keys()].sort(compareVersions).at(-1);
  return latest === undefined ? null : (versions.get(latest) ?? null);
}

export function listComponents(): ComponentDefinition<unknown>[] {
  return [...registry.entries()]
    .flatMap(([, versions]) => [...versions.values()])
    .sort((left, right) => left.type.localeCompare(right.type) || compareVersions(left.version, right.version));
}

/** 可序列化目录（编辑器/API 消费者用；不含 renderer）。 */
export function componentCatalog(): ComponentCatalogEntry[] {
  return listComponents().map((definition) => toCatalogEntry(definition));
}

/** V1 标准 20 类中尚未注册的组件类型（P05-02 必须为空）。 */
export function missingStandardComponents(): string[] {
  return STANDARD_SCENE_TYPES.filter((type) => getComponent(type) === null);
}

/** 测试/装配辅助：清空注册表（仅测试使用，生产装配不得调用）。 */
export function resetRegistryForTesting(): void {
  registry.clear();
}
