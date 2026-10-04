import io

# 1) server：注册 narrative 路由 + content.llm 选项
p = 'apps/api/src/server.ts'
s = io.open(p, encoding='utf-8').read()
s = s.replace("import { registerJobRoutes } from './routes/jobs.js';",
"import { registerJobRoutes } from './routes/jobs.js';\nimport { registerNarrativeRoutes } from './routes/narrative.js';")
old = "        registerEvidenceRoutes(instance, authDeps);"
new = "        registerEvidenceRoutes(instance, authDeps);\n        registerNarrativeRoutes(instance, authDeps, contentDeps?.llm);"
assert s.count(old) == 1, 'evidence route anchor'
s = s.replace(old, new)
old_opt = "  /** 内容输入依赖（P04-01）：文章抓取器（URL 归一化所需） */\n  content?: { articleFetcher?: import('@ancs/contracts').ArticleFetcher };"
new_opt = """  /**
   * 内容输入依赖（P04-01）与叙事生成依赖（P04-03）：
   * articleFetcher（URL 归一化）、llm（结构化生成；无凭据时可注入 Mock，§76-03）。
   */
  content?: { articleFetcher?: import('@ancs/contracts').ArticleFetcher; llm?: import('@ancs/contracts').LlmAdapter };"""
assert s.count(old_opt) == 1, 'content option'
s = s.replace(old_opt, new_opt)
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('server wired')

# 2) bootstrap：LLM 驱动（默认 mock + 明确提示；未知名 fail-closed）
p = 'apps/api/src/index.ts'
s = io.open(p, encoding='utf-8').read()
s = s.replace("import { createHttpArticleFetcher } from './plugins/article-fetcher.js';",
"import { createHttpArticleFetcher } from './plugins/article-fetcher.js';\nimport { MockLlmAdapter } from '@ancs/providers-mock-llm';")
old = "  content: { articleFetcher: createHttpArticleFetcher() },"
new = """  content: { articleFetcher: createHttpArticleFetcher(), ...llmDeps },"""
assert s.count(old) == 1, 'content bootstrap'
s = s.replace(old, new)
old2 = "const credentialDeps = credentialDepsFromEnv();"
new2 = """const credentialDeps = credentialDepsFromEnv();

/**
 * LLM 适配器（P04-03）：无真实凭据时使用**明确 Mock**（§76-03：不得伪造"真实生成成功"）。
 * ANCS_LLM_DRIVER=mock（默认）| 未来真实驱动名（未知名 → 启动失败，fail-closed）。
 */
const llmDriver = process.env['ANCS_LLM_DRIVER'] ?? 'mock';
let llmDeps: { llm?: import('@ancs/contracts').LlmAdapter };
if (llmDriver === 'mock') {
  console.warn('[api] LLM 驱动 = mock（无真实凭据）：叙事生成为 Mock 输出，不得视为真实模型结果。');
  llmDeps = { llm: new MockLlmAdapter() };
} else {
  console.error(`启动失败：未知的 ANCS_LLM_DRIVER=${llmDriver}（当前仅支持 mock；真实适配器随 P06-01 接入）。`);
  process.exit(1);
}"""
assert s.count(old2) == 1, 'llm bootstrap'
s = s.replace(old2, new2)
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('bootstrap wired')

# 3) SDK：narrative 方法
p = 'packages/sdk/src/client.ts'
s = io.open(p, encoding='utf-8').read()
old = """  extractionResultSchema,
  factVisualDecisionSchema,"""
new = """  extractionResultSchema,
  factVisualDecisionSchema,
  narrationBlockSchema,
  narrativeGenerationResultSchema,
  narrativePlanSchema,
  updateNarrationBlockRequestSchema,"""
assert s.count(old) == 1, 'sdk imports'
s = s.replace(old, new)
old = """  type ExtractionResult,
  type FactVisualDecision,"""
new = """  type ExtractionResult,
  type FactVisualDecision,
  type NarrationBlock,
  type NarrativeGenerationResult,
  type NarrativePlan,"""
assert s.count(old) == 1, 'sdk types'
s = s.replace(old, new)
old = """  evidence: {"""
new = """  narrative: {
    /** 生成叙事计划（结构化 + 有限修复 + 锁定保留 + 口语化门控） */
    generate(
      workspaceId: string,
      projectId: string,
      documentId: string,
      input: { targetDurationMs: number; tone?: string | null; audience?: string | null; platform?: string | null },
      options?: MutationOptions,
    ): Promise<NarrativeGenerationResult>;
    /** 当前计划（无则 null） */
    current(workspaceId: string, projectId: string): Promise<NarrativePlan | null>;
    /** 版本列表（revision 降序） */
    plans(workspaceId: string, projectId: string): Promise<NarrativePlan[]>;
    /** 修订旁白块（锁定后改文本 → 409） */
    updateBlock(
      workspaceId: string,
      projectId: string,
      planId: string,
      blockId: string,
      input: { text?: string; locked?: boolean; status?: 'DRAFT' | 'NEEDS_REVIEW' | 'APPROVED' },
      options?: MutationOptions,
    ): Promise<NarrationBlock>;
  };
  evidence: {"""
assert s.count(old) == 1, 'sdk interface'
s = s.replace(old, new)
old = """    evidence: {
      extract: (workspaceId, projectId, documentId, mutation) =>"""
new = """    narrative: {
      generate: (workspaceId, projectId, documentId, input, mutation) =>
        request('POST', `/api/v1/workspaces/${workspaceId}/projects/${projectId}/narrative/generate`, narrativeGenerationResultSchema, {
          body: { documentId, ...input },
          bodySchema: z.object({
            documentId: z.string().min(1),
            targetDurationMs: z.number().int().positive(),
            tone: z.string().nullable().optional(),
            audience: z.string().nullable().optional(),
            platform: z.string().nullable().optional(),
          }),
          idempotencyKey: mutation?.idempotencyKey,
        }),
      current: (workspaceId, projectId) =>
        request('GET', `/api/v1/workspaces/${workspaceId}/projects/${projectId}/narrative`, narrativePlanSchema.nullable()),
      plans: async (workspaceId, projectId) =>
        (await request('GET', `/api/v1/workspaces/${workspaceId}/projects/${projectId}/narrative/plans`, listOf(narrativePlanSchema))).items,
      updateBlock: (workspaceId, projectId, planId, blockId, input, mutation) =>
        request(
          'PATCH',
          `/api/v1/workspaces/${workspaceId}/projects/${projectId}/narrative/${planId}/blocks/${blockId}`,
          narrationBlockSchema,
          {
            body: input,
            bodySchema: updateNarrationBlockRequestSchema,
            idempotencyKey: mutation?.idempotencyKey,
          },
        ),
    },

    evidence: {
      extract: (workspaceId, projectId, documentId, mutation) =>"""
assert s.count(old) == 1, 'sdk impl'
s = s.replace(old, new)
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('sdk wired')
