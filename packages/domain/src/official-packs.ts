import {
  packManifestSchema,
  type OutputPlan,
  type PackPlugin,
  type RestrictedPluginContext,
} from '@ancs/contracts';

/**
 * 官方 Pack：Shorts Analyzer（P11-03 / §92.1）。
 *
 * 定位：**证明 Pack 契约可工作**的首个实例——analyze 消费受限上下文中的 Fit 与 Atom（只读数据面），
 * 产出 Short 规划骨架（OutputPlan；generate/validate 属 P12 Shorts Pack 的完整实现）。
 * 纯逻辑：不触 DB、不持 Secret——数据全部来自能力门控后的 ctx.data。
 */

export const SHORTS_ANALYZER_MANIFEST = packManifestSchema.parse({
  manifestVersion: 'pack-manifest-v1',
  packId: 'ancs.pack.shorts-analyzer',
  name: 'Shorts Analyzer',
  version: '1.0.0',
  description: '从 Atom/Fit 产出 Short 规划骨架（官方 Pack；证明 Pack 公开契约可工作）',
  capabilities: ['read_content_core'],
  compatibility: { coreRange: '>=1.0.0', sceneGraphSchemaVersion: null },
  outputFormats: ['shorts_9x16'],
  defaultChannelKey: 'SHORT_INSIGHT',
  quota: null,
  signature: null,
});

const MAX_PLAN_ATOMS = 3;

export function createShortsAnalyzerPlugin(): PackPlugin {
  return {
    manifest: SHORTS_ANALYZER_MANIFEST,
    async analyze(ctx: RestrictedPluginContext): Promise<OutputPlan> {
      const fit = ctx.data.fit;
      const blocking = fit?.reasons.filter((reason) => reason.severity === 'BLOCKING') ?? [];

      if (fit === null) {
        return {
          schemaVersion: 'output-plan-v1',
          summary: '无法评估 Channel Fit（渠道不可用）：请检查项目内容后重试。',
          items: [],
          requiresApproval: true,
        };
      }
      if (blocking.length > 0) {
        return {
          schemaVersion: 'output-plan-v1',
          summary: `Channel Fit = ${fit.verdict}：${blocking.map((reason) => reason.message).join('；')}——不建议生成该渠道版本（可补足素材后重新分析）。`,
          items: [],
          requiresApproval: true,
        };
      }

      // 可传播 Atom 优先级：KEY_NUMBER > SUB_TOPIC > 其余（上限 3 条——Short 单点洞察）
      const candidates = [...ctx.data.atoms].sort((left, right) => {
        const weight = (kind: string): number => (kind === 'KEY_NUMBER' ? 0 : kind === 'SUB_TOPIC' ? 1 : 2);
        return weight(left.kind) - weight(right.kind);
      });
      const selected = candidates.slice(0, MAX_PLAN_ATOMS);
      const verdictNote = fit.verdict === 'OPTIONAL' ? '（素材偏薄：建议补足 Atom 后生成）' : '';

      return {
        schemaVersion: 'output-plan-v1',
        summary: `Channel Fit = ${fit.verdict}${verdictNote}：规划 ${String(selected.length)} 条 Short 观点（45–90s 单点洞察；hook < 3s）。`,
        items: selected.map((atom) => ({
          id: `planitem_atom_${atom.id}`,
          kind: 'generate' as const,
          description: `以「${atom.title}」为核心观点生成 Short（来源可追溯：${atom.sourceRefs.map((ref) => ref.claimId ?? ref.sourceId ?? '').filter((value) => value !== '').join(' / ')}）`,
        })),
        requiresApproval: true,
      };
    },
  };
}
