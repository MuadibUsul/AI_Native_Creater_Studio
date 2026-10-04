import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  contentDocumentSchema,
  datasetsFileSchema,
  fixtureExpectedSchema,
  negativeCaseSchema,
  sourcesFileSchema,
  type FixtureBundle,
  type NegativeCase,
} from './fixture-schema.js';

/** fixtures 根目录（src 与 dist 下的相对位置一致：包根/fixtures）。 */
export const FIXTURES_ROOT = join(import.meta.dirname, '..', 'fixtures');

export const GOLDEN_FRENCH_DEBT_DIR = join(FIXTURES_ROOT, 'golden', 'french-debt');
export const NEGATIVE_CASES_DIR = join(FIXTURES_ROOT, 'negative', 'cases');

export async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

/**
 * 从目录加载一份 fixture bundle 并做结构校验（Zod）。
 * 不做任何网络访问——测试不依赖实时网页内容变化（计划 P00-04 验收）。
 */
export async function loadFixtureBundle(dir: string): Promise<FixtureBundle> {
  const [content, sources, datasets, expected] = await Promise.all([
    readJson(join(dir, 'content.json')),
    readJson(join(dir, 'sources.json')),
    readJson(join(dir, 'datasets.json')),
    readJson(join(dir, 'expected.json')),
  ]);

  return {
    content: contentDocumentSchema.parse(content),
    sources: sourcesFileSchema.parse(sources).sources,
    datasets: datasetsFileSchema.parse(datasets).datasets,
    expected: fixtureExpectedSchema.parse(expected),
  };
}

/** 加载全部合成负面用例（明显标注；仅用于验证校验与降级路径）。 */
export async function loadNegativeCases(): Promise<NegativeCase[]> {
  const files = (await readdir(NEGATIVE_CASES_DIR)).filter((f) => f.endsWith('.json')).sort();
  return Promise.all(files.map(async (file) => negativeCaseSchema.parse(await readJson(join(NEGATIVE_CASES_DIR, file)))));
}
