import { createHash } from 'node:crypto';
import type { FixtureBundle } from './fixture-schema.js';

/** fixture 完整性审计的问题码（顺序即审计执行顺序）。 */
export type AuditIssueCode =
  | 'SOURCE_HASH_MISMATCH'
  | 'UNRESOLVED_SOURCE'
  | 'UNRESOLVED_DATASET'
  | 'MISSING_PROVENANCE'
  | 'SYNTHETIC_AS_FACTUAL'
  | 'OVERFLOW_RISK';

export interface AuditIssue {
  code: AuditIssueCode;
  severity: 'error' | 'warning';
  path: string;
  message: string;
}

/** 溢出启发式阈值（占位：P05 起由组件安全区检测取代，见 §11.3 / §86）。 */
export const OVERFLOW_NARRATION_MAX_CHARS = 140;
export const OVERFLOW_TITLE_MAX_CHARS = 50;

export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * 审计一份 fixture bundle（golden 与负面用例共用）：
 * - 来源快照的 contentHash 必须等于存储摘录的 sha256；
 * - 所有 source/dataset 引用必须可解析；
 * - fact 级 Claim 必须有来源（§56：AI 不得伪造来源）；
 * - 合成数据（synthetic）不得被事实图表引用（§10.3 / AC-15）；
 * - 文本溢出启发式仅警告，不阻断（最终由组件安全区检测）。
 */
export function auditFixture(bundle: FixtureBundle): AuditIssue[] {
  const issues: AuditIssue[] = [];
  const sourceIds = new Set(bundle.sources.map((s) => s.sourceId));
  const datasetIds = new Set(bundle.datasets.map((d) => d.id));

  // 1. 来源快照哈希完整性
  for (const source of bundle.sources) {
    const actual = sha256Hex(source.excerpt);
    if (actual !== source.contentHash) {
      issues.push({
        code: 'SOURCE_HASH_MISMATCH',
        severity: 'error',
        path: `sources.${source.sourceId}`,
        message: `contentHash 与摘录内容不一致（期望 ${actual.slice(0, 12)}…）`,
      });
    }
  }

  // 2. 引用可解析性：claims / citations / datasets / expected
  for (const claim of bundle.content.claims) {
    for (const sourceId of claim.sourceIds) {
      if (!sourceIds.has(sourceId)) {
        issues.push({
          code: 'UNRESOLVED_SOURCE',
          severity: 'error',
          path: `content.claims.${claim.id}`,
          message: `sourceId "${sourceId}" 不存在`,
        });
      }
    }
    for (const reference of claim.structuredData) {
      if (!datasetIds.has(reference.datasetId)) {
        issues.push({
          code: 'UNRESOLVED_DATASET',
          severity: 'error',
          path: `content.claims.${claim.id}`,
          message: `datasetId "${reference.datasetId}" 不存在`,
        });
      }
    }
  }

  for (const citation of bundle.content.citations) {
    if (!sourceIds.has(citation.sourceId)) {
      issues.push({
        code: 'UNRESOLVED_SOURCE',
        severity: 'error',
        path: `content.citations.${citation.id}`,
        message: `sourceId "${citation.sourceId}" 不存在`,
      });
    }
  }

  for (const dataset of bundle.datasets) {
    for (const sourceId of dataset.sourceIds) {
      if (!sourceIds.has(sourceId)) {
        issues.push({
          code: 'UNRESOLVED_SOURCE',
          severity: 'error',
          path: `datasets.${dataset.id}`,
          message: `sourceId "${sourceId}" 不存在`,
        });
      }
    }
  }

  for (const table of bundle.content.tables) {
    if (table.datasetId !== undefined && !datasetIds.has(table.datasetId)) {
      issues.push({
        code: 'UNRESOLVED_DATASET',
        severity: 'error',
        path: `content.tables.${table.id}`,
        message: `datasetId "${table.datasetId}" 不存在`,
      });
    }
  }

  const syntheticDatasets = new Set(bundle.datasets.filter((d) => d.synthetic).map((d) => d.id));
  for (const scene of bundle.expected.requiredScenes) {
    if (scene.datasetId !== undefined) {
      if (!datasetIds.has(scene.datasetId)) {
        issues.push({
          code: 'UNRESOLVED_DATASET',
          severity: 'error',
          path: `expected.requiredScenes.${scene.sceneType}`,
          message: `datasetId "${scene.datasetId}" 不存在`,
        });
      } else if (syntheticDatasets.has(scene.datasetId)) {
        issues.push({
          code: 'SYNTHETIC_AS_FACTUAL',
          severity: 'error',
          path: `expected.requiredScenes.${scene.sceneType}`,
          message: `合成数据集 "${scene.datasetId}" 被事实图表引用`,
        });
      }
    }
    if (scene.sourceId !== undefined && !sourceIds.has(scene.sourceId)) {
      issues.push({
        code: 'UNRESOLVED_SOURCE',
        severity: 'error',
        path: `expected.requiredScenes.${scene.sceneType}`,
        message: `sourceId "${scene.sourceId}" 不存在`,
      });
    }
  }

  // 3. 事实必须有来源
  for (const claim of bundle.content.claims) {
    if (claim.factuality === 'fact' && claim.sourceIds.length === 0) {
      issues.push({
        code: 'MISSING_PROVENANCE',
        severity: 'error',
        path: `content.claims.${claim.id}`,
        message: 'fact 级 Claim 缺少来源绑定（§56）',
      });
    }
  }

  // 4. 文本溢出启发式（warning）
  if (bundle.content.title.length > OVERFLOW_TITLE_MAX_CHARS) {
    issues.push({
      code: 'OVERFLOW_RISK',
      severity: 'warning',
      path: 'content.title',
      message: `标题长度 ${String(bundle.content.title.length)} 超过启发式阈值 ${String(OVERFLOW_TITLE_MAX_CHARS)}`,
    });
  }
  for (const scene of bundle.expected.requiredScenes) {
    const line = scene.narrationLine;
    if (line !== undefined && line.length > OVERFLOW_NARRATION_MAX_CHARS) {
      issues.push({
        code: 'OVERFLOW_RISK',
        severity: 'warning',
        path: `expected.requiredScenes.${scene.sceneType}`,
        message: `narrationLine 长度 ${String(line.length)} 超过启发式阈值 ${String(OVERFLOW_NARRATION_MAX_CHARS)}`,
      });
    }
  }

  return issues;
}
