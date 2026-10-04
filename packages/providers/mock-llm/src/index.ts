import type { LlmAdapter, LlmCompletion, NarrativeGenerationRequest } from '@ancs/contracts';

/**
 * Mock LLM 适配器（P04-03 / §52；同 P03-07 的 Mock Provider 范式）。
 *
 * 用途：在**无真实 LLM 凭据**时确定性重现生成与故障场景：
 *   valid（合法 JSON）/ fenced（代码围栏包裹）/ repairable（可有限修复：未知字段、字符串数字、缺可选字段）/
 *   invalid_then_valid（首次不可修复 → 重试一次成功，验证"有限修复 + 有限重试"）/
 *   unrepairable（结构性缺失，必须明确失败）/ verbatim（旁白逐字抄原文，触发口语化门控）/
 *   timeout|error（上游失败）。
 *
 * 输出为**结构化 JSON 字符串**（真实 LLM 也应按 §52 返回结构化输出）；内容由输入确定性派生，
 * 因此测试可断言（如"旁白必须引用事实 id""锁定旁白逐字保留"）。
 */

export const MOCK_LLM_MODES = ['valid', 'fenced', 'repairable', 'invalid_then_valid', 'unrepairable', 'verbatim', 'timeout', 'error'] as const;
export type MockLlmMode = (typeof MOCK_LLM_MODES)[number];

export interface MockLlmOptions {
  providerId?: string;
  modelVersion?: string;
  /** 默认模式（未排队时使用） */
  defaultMode?: MockLlmMode;
  /** 每段旁白的目标字数（默认按 220 字/分钟估算目标时长） */
  charsPerMinute?: number;
}

interface PlanShape {
  title: string;
  thesis: string;
  hook: string;
  chapters: { title: string; intent: string; narrationBlockIds: string[] }[];
  narrationBlocks: { id: string; text: string; chapterTitle: string; claimIds: string[] }[];
  keyClaims: string[];
  ending: string;
}

export class MockLlmAdapter implements LlmAdapter {
  readonly providerId: string;
  /** 可观测：调用次数与最后一次请求（断言重试次数/提示词内容） */
  callCount = 0;
  lastRequest: NarrativeGenerationRequest | null = null;
  lastSystemPrompt: string | null = null;
  private readonly modes: MockLlmMode[] = [];
  private readonly options: Required<Omit<MockLlmOptions, 'providerId'>> & { providerId: string };

  constructor(options: MockLlmOptions = {}) {
    this.providerId = options.providerId ?? 'mock.llm';
    this.options = {
      providerId: this.providerId,
      modelVersion: options.modelVersion ?? 'mock-llm-2026-10',
      defaultMode: options.defaultMode ?? 'valid',
      charsPerMinute: options.charsPerMinute ?? 220,
    };
  }

  scriptNext(mode: MockLlmMode): this {
    this.modes.push(mode);
    return this;
  }

  async complete(input: { request: NarrativeGenerationRequest; systemPrompt: string; userPrompt: string }): Promise<LlmCompletion> {
    this.callCount += 1;
    this.lastRequest = input.request;
    this.lastSystemPrompt = input.systemPrompt;
    const mode = this.modes.shift() ?? this.options.defaultMode;
    const promptVersion = /promptVersion:\s*(\S+)/.exec(input.systemPrompt)?.[1] ?? 'narrative-v1';

    if (mode === 'timeout') throw new Error('Mock LLM：上游超时（模拟）');
    if (mode === 'error') throw new Error('Mock LLM：上游 500（模拟）');
    if (mode === 'unrepairable') {
      return { content: JSON.stringify({ title: '只有标题' }), modelVersion: this.options.modelVersion, promptVersion, usage: {} };
    }

    const plan = this.buildPlan(input.request);
    if (mode === 'verbatim') {
      // 全部旁白逐字复制原文（触发 8-gram 重叠门控；§8.2 不得逐字朗读）
      const digestTexts = input.request.contentDigest.map((item) => item.text).filter((text) => text.length >= 12);
      const pool = digestTexts.length > 0 ? digestTexts : ['原文内容缺失时的占位段落（Mock）'];
      plan.narrationBlocks = plan.narrationBlocks.map((block, index) => ({
        ...block,
        text: pool[index % pool.length] ?? '占位',
      }));
      return { content: JSON.stringify(plan), modelVersion: this.options.modelVersion, promptVersion, usage: {} };
    }
    if (mode === 'fenced') {
      return { content: `\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``, modelVersion: this.options.modelVersion, promptVersion, usage: {} };
    }
    if (mode === 'repairable') {
      const repairable = {
        ...plan,
        // 未知字段（应按严格契约剔除并记录修复）
        extraFieldFromModel: 'should-be-dropped',
        // 字符串数字（应被有限修复为数字）
        estimatedDuration: String(Math.round(input.request.targetDurationMs / 1000)),
        // 缺 ending（应由第一章/标题安全派生）
        ending: undefined,
      };
      return { content: JSON.stringify(repairable), modelVersion: this.options.modelVersion, promptVersion, usage: {} };
    }
    if (mode === 'invalid_then_valid') {
      return { content: '这不是 JSON —— 模型输出损坏（模拟）', modelVersion: this.options.modelVersion, promptVersion, usage: {} };
    }
    return { content: JSON.stringify(plan), modelVersion: this.options.modelVersion, promptVersion, usage: {} };
  }

  /** 确定性"改写"：只提取数字/主题词并重新组句（保证与原文无 ≥8 字重叠）。 */
  private paraphrase(text: string, index: number): string {
    const numbers = [...text.matchAll(/(-?\d+(?:\.\d+)?)\s*(%|％|个百分点|亿|万|倍|美元|元|bp)?/g)]
      .map((match) => `${match[1] ?? ''}${match[2] ?? ''}`)
      .slice(0, 3);
    const leads = ['我们先把镜头拉近', '换个角度看', '值得停下来想一想', '顺着这条线', '把镜头拉远'];
    const lead = leads[index % leads.length] ?? leads[0];
    if (numbers.length > 0) {
      return `${lead}：关键的量级是 ${numbers.join('、')} 这个范围，它决定了后面讨论的方向与力度。`;
    }
    const topic = text.replace(/[，。；：、,.!?！？\s]/g, '').slice(0, 3);
    return `${lead}：围绕「${topic}」这件事，故事还有更多层次值得展开。`;
  }

  /** 由请求确定性派生叙事计划（口语化改写：不复述原文，使用引导语 + 事实引用）。 */
  private buildPlan(request: NarrativeGenerationRequest): PlanShape {
    const factClaims = request.claims.filter((claim) => claim.factuality === 'fact');
    const keyClaims = factClaims.slice(0, 6).map((claim) => claim.claimId);
    const targetSeconds = Math.max(30, Math.round(request.targetDurationMs / 1000));
    const blocksWanted = Math.max(3, Math.min(12, Math.round(targetSeconds / 20)));

    const narrationBlocks: PlanShape['narrationBlocks'] = [];
    // 锁定旁白优先逐字保留（§8.2）
    for (const locked of request.lockedNarrationBlocks) {
      narrationBlocks.push({
        id: locked.id,
        text: locked.text,
        chapterTitle: '保留段落',
        claimIds: [],
      });
    }
    const sources = request.claims.length > 0 ? request.claims : request.contentDigest.map((item) => ({ claimId: '', text: item.text, factuality: 'analysis' as const, locked: false }));
    for (let index = 0; index < blocksWanted; index += 1) {
      const claim = sources[index % Math.max(sources.length, 1)];
      if (claim === undefined) break;
      // 口语化改写（不复制原文 ≥8 字片段——由口语化门控约束，Mock 也遵守）
      const text = this.paraphrase(claim.text, index);
      narrationBlocks.push({
        id: `nrg_${String(index + 1)}`, // 生成块前缀与锁定块（保留原 id）区分，避免逻辑 ID 冲突
        text,
        chapterTitle: index < Math.ceil(blocksWanted / 2) ? '开场与核心事实' : '影响与总结',
        claimIds: claim.claimId === '' ? [] : [claim.claimId],
      });
    }
    const chapterTitles = [...new Set(narrationBlocks.map((block) => block.chapterTitle))];
    return {
      title: `${request.documentTitle}｜视频叙事`,
      thesis: `围绕「${request.documentTitle}」解释发生了什么、为什么重要。`,
      hook: '先抛出一个反常识的事实，让观众愿意看下去。',
      chapters: chapterTitles.map((title, index) => ({
        title,
        intent: index === 0 ? '建立问题与背景' : '给出影响与结尾',
        narrationBlockIds: narrationBlocks.filter((block) => block.chapterTitle === title).map((block) => block.id),
      })),
      narrationBlocks,
      keyClaims,
      ending: '总结核心结论，并提示下一步关注点。',
    };
  }
}
