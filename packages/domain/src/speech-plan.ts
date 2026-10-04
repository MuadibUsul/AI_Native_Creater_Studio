import {
  ApiFailure,
  ERROR_CODES,
  SPEECH_PLAN_VERSION,
  SPEECH_ROLE_STYLE_DEFAULTS,
  SPEECH_WARNING_CODES,
  mergeSpeechProfileFields,
  speechPlanSchema,
  type ContentBlock,
  type NarrationBlock,
  type SpeechPlan,
  type SpeechSceneRole,
  type SpeechSegment,
  type SpeechStyleOverrides,
  type SpeechWarning,
  type SpeechProfileFields,
} from '@ancs/contracts';
import { extractNumericMentions } from './evidence-extract.js';
import { getChannel } from './channels.js';
import { getCreatorIdentity } from './creator-identities.js';
import { planVisual } from './visual-plan.js';
import { getPlan } from './narrative.js';
import { getProject } from './projects.js';
import { getSpeechProfile } from './speech-profiles.js';
import { buildDirectorScenes, resolveDirectorPolicy } from './director.js';
import { resolveProviderRoute } from './credentials.js';
import type { DomainDeps } from './channels.js';

/**
 * Speech Director（P04-06 / 规范 §94、§6.4、§95；计划 §8 P04-06）。
 *
 * 将旁白语义、身份（VoiceIdentity 版本）、语气（SpeechProfile 版本）与时长目标
 * 转为**供应商无关**的 SpeechPlan：
 * - 角色（Hook/解释/关键数字/引用/结论）由块位置 + 语义类型确定性判定（§94 默认规则）；
 * - 语速/能量 = profile 默认 × 角色修正（可覆盖），越界**钳制并记录**（可解释降级）；
 * - 关键数字 → 前后停顿 + 强调区间；句子间隙 → 停顿；发音词典 → 命中替换；
 * - **不泄漏 Provider 私有参数**：计划只带 voiceIdentityId/version；provider/providerVoiceId
 *   留在身份资产与凭据系统，映射到具体 Provider 参数由合成 Adapter 负责（§94 末款）；
 * - 无可用 TTS → 明确警示"风格参数支持情况未核验"（不冒充可合成）。
 */

const SPEED_MIN = 0.5;
const SPEED_MAX = 2;
const MAX_NUMBER_MENTIONS_PER_SEGMENT = 3;

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

/** 4 位小数收敛（消除浮点噪声；计划值不需要更高精度）。 */
const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

/**
 * 角色判定（确定性；§94 默认规则的优先序）：
 * HOOK（首段）→ QUOTE（引用语义）→ CONCLUSION（末段，结构优先）→ NUMBER（含关键数字）
 * → EXPLANATION（解释类语义）→ BODY。
 */
export function resolveSceneRole(
  index: number,
  total: number,
  semanticType: string | undefined,
  hasNumbers = false,
): SpeechSceneRole {
  if (index === 0) return 'HOOK';
  if (semanticType === 'QUOTE') return 'QUOTE';
  if (index === total - 1) return 'CONCLUSION';
  const numericSemantics = semanticType !== undefined && ['NUMBER', 'PERCENT_CHANGE', 'KPI_SET'].includes(semanticType);
  if (hasNumbers || numericSemantics) return 'NUMBER';
  if (semanticType !== undefined && ['CONCEPT', 'CAUSE_EFFECT', 'FEEDBACK_LOOP', 'PROCESS', 'FLOW', 'NETWORK'].includes(semanticType)) {
    return 'EXPLANATION';
  }
  return 'BODY';
}

const ROLE_STYLE_KEY: Record<SpeechSceneRole, keyof SpeechProfileFields | null> = {
  HOOK: 'hookStyle',
  BODY: 'bodyStyle',
  EXPLANATION: 'explanationStyle',
  NUMBER: 'numberReadingStyle',
  QUOTE: 'quoteStyle',
  CONCLUSION: 'conclusionStyle',
};

/** 文本中的句子边界（用于句子间隙停顿）。 */
const SENTENCE_ENDINGS = new Set(['。', '！', '？', '；', '!', '?', ';']);

/**
 * 构建段落（纯函数；确定性）。`sceneIdByBlock` 用于把段落关联到 Director 场景（可选）。
 */
export function buildSpeechSegments(input: {
  blocks: readonly NarrationBlock[];
  semanticByBlock: ReadonlyMap<string, string>;
  profile: SpeechProfileFields;
  styleOverrides?: SpeechStyleOverrides;
  sceneIdByBlock?: ReadonlyMap<string, string>;
}): { segments: SpeechSegment[]; warnings: SpeechWarning[] } {
  const { blocks, semanticByBlock, profile, styleOverrides } = input;
  const segments: SpeechSegment[] = [];
  const warnings: SpeechWarning[] = [];
  const planPrefix = 'spk';

  blocks.forEach((block, index) => {
    const segmentId = `${planPrefix}_${String(index + 1)}`;
    const semanticType = semanticByBlock.get(block.id);
    const numberMentions = extractNumericMentions({ id: `blk_role_${block.id}`, type: 'paragraph', text: block.text } satisfies ContentBlock);
    const sceneRole = resolveSceneRole(index, blocks.length, semanticType, numberMentions.length > 0);
    const rule = { ...SPEECH_ROLE_STYLE_DEFAULTS[sceneRole], ...(styleOverrides?.[sceneRole] ?? {}) };

    const requestedSpeed = round4(profile.defaultSpeed * rule.speedMultiplier);
    const speed = round4(clamp(requestedSpeed, SPEED_MIN, SPEED_MAX));
    const requestedEnergy = round4(profile.energy + rule.energyDelta);
    const energy = round4(clamp(requestedEnergy, 0, 1));
    const degradations: { code: string; message: string }[] = [];
    if (Math.abs(speed - requestedSpeed) > 1e-9) {
      degradations.push({ code: SPEECH_WARNING_CODES.SPEED_CLAMPED, message: `语速 ${requestedSpeed.toFixed(2)} 超出支持范围 [${String(SPEED_MIN)}, ${String(SPEED_MAX)}] → 钳制为 ${speed.toFixed(2)}` });
      warnings.push({ code: SPEECH_WARNING_CODES.SPEED_CLAMPED, severity: 'INFO', message: `${segmentId} 语速被钳制（${requestedSpeed.toFixed(2)} → ${speed.toFixed(2)}）`, segmentId });
    }
    if (Math.abs(energy - requestedEnergy) > 1e-9) {
      degradations.push({ code: SPEECH_WARNING_CODES.ENERGY_CLAMPED, message: `能量 ${requestedEnergy.toFixed(2)} 超出 [0, 1] → 钳制为 ${energy.toFixed(2)}` });
      warnings.push({ code: SPEECH_WARNING_CODES.ENERGY_CLAMPED, severity: 'INFO', message: `${segmentId} 能量被钳制（${requestedEnergy.toFixed(2)} → ${energy.toFixed(2)}）`, segmentId });
    }

    // 停顿与强调：关键数字（上限 3 个，避免过度停顿）+ 句子间隙
    const mentions = numberMentions.slice(0, MAX_NUMBER_MENTIONS_PER_SEGMENT);
    const pauses: SpeechSegment['pauses'] = [];
    const emphasisSpans: SpeechSegment['emphasisSpans'] = [];
    for (const mention of mentions) {
      pauses.push({ afterCharIndex: mention.offset, durationMs: 120, reason: 'NUMBER_PREPAUSE' });
      pauses.push({ afterCharIndex: mention.offset + mention.raw.length, durationMs: 200, reason: 'NUMBER_POSTPAUSE' });
      emphasisSpans.push({ startChar: mention.offset, endChar: mention.offset + mention.raw.length, reason: 'KEY_NUMBER' });
    }
    if (profile.sentenceGapMs > 0) {
      for (let charIndex = 0; charIndex < block.text.length; charIndex += 1) {
        const char = block.text[charIndex];
        if (char !== undefined && SENTENCE_ENDINGS.has(char)) {
          pauses.push({ afterCharIndex: charIndex + 1, durationMs: profile.sentenceGapMs, reason: 'SENTENCE_GAP' });
        }
      }
    }
    // 同一位置只保留一个停顿（优先级：数字停顿 > 句子间隙）
    const merged: SpeechSegment['pauses'] = [];
    for (const pause of pauses.sort((a, b) => a.afterCharIndex - b.afterCharIndex || b.durationMs - a.durationMs)) {
      if (merged.some((existing) => existing.afterCharIndex === pause.afterCharIndex)) continue;
      merged.push(pause);
    }

    const pronunciationOverrides = profile.pronunciationDictionary.filter((entry) => block.text.includes(entry.term));

    const styleKey = ROLE_STYLE_KEY[sceneRole];
    const styleInstruction = styleKey === null ? profile.bodyStyle : String(profile[styleKey]);
    const expectedDurationMs = Math.max(1, Math.round(block.estimatedDurationMs / speed));

    segments.push({
      segmentId,
      narrationBlockId: block.id,
      sceneId: input.sceneIdByBlock?.get(block.id) ?? null,
      text: block.text,
      charCount: [...block.text].length,
      sceneRole,
      speed,
      energy,
      toneInstruction: profile.tone,
      styleInstruction,
      pauses: merged,
      emphasisSpans,
      pronunciationOverrides,
      expectedDurationMs,
      locked: block.locked,
      degradations,
    });
  });

  return { segments, warnings };
}

/** SpeechPlan 生成（身份/风格来自 Channel 默认 → 请求覆盖 → 身份默认 → 系统默认）。 */
export async function planSpeech(
  deps: DomainDeps,
  input: {
    workspaceId: string;
    projectId: string;
    planId: string;
    identityId?: string;
    speechProfileId?: string;
    styleOverrides?: SpeechStyleOverrides;
  },
): Promise<SpeechPlan> {
  const plan = await getPlan(deps, { workspaceId: input.workspaceId, projectId: input.projectId, planId: input.planId });
  const visual = await planVisual(deps, input);
  const project = await getProject(deps, { workspaceId: input.workspaceId, projectId: input.projectId });
  const channel = await getChannel(deps, { workspaceId: input.workspaceId, channelId: project.channelId });
  const defaults = channel.styleVersion.defaults;

  const warnings: SpeechWarning[] = [];

  // 声音身份：请求 > Channel 默认（引用身份资产；**Provider 参数不进入计划**）
  const identityId = input.identityId ?? defaults.creatorIdentityId ?? null;
  let voice: SpeechPlan['voice'] = { voiceIdentityId: null, voiceIdentityVersion: null };
  if (identityId !== null) {
    const identity = await getCreatorIdentity(deps, { workspaceId: input.workspaceId, creatorIdentityId: identityId });
    if (identity.voiceIdentity !== null) {
      voice = { voiceIdentityId: identity.voiceIdentity.id, voiceIdentityVersion: identity.voiceIdentity.version };
    }
  }
  if (voice.voiceIdentityId === null) {
    warnings.push({ code: SPEECH_WARNING_CODES.NO_VOICE_IDENTITY, severity: 'WARNING', message: '未绑定声音身份（VoiceIdentity）：计划可用于审阅，但合成前必须绑定（否则生成会被明确阻止）', segmentId: null });
  }

  // SpeechProfile：请求 > Channel 默认 > 身份默认 > 系统默认
  let profileFields: SpeechProfileFields;
  let speechProfileRef: SpeechPlan['speechProfile'];
  if (input.speechProfileId !== undefined) {
    const profile = await getSpeechProfile(deps, { workspaceId: input.workspaceId, speechProfileId: input.speechProfileId });
    profileFields = profile.latest.fields;
    speechProfileRef = { id: profile.id, version: profile.currentVersion, source: 'REQUEST' };
  } else if (defaults.speechProfileId !== null) {
    const profile = await getSpeechProfile(deps, { workspaceId: input.workspaceId, speechProfileId: defaults.speechProfileId });
    profileFields = profile.latest.fields;
    speechProfileRef = { id: profile.id, version: profile.currentVersion, source: 'CHANNEL' };
  } else {
    profileFields = mergeSpeechProfileFields(undefined);
    speechProfileRef = { id: null, version: null, source: 'DEFAULT' };
  }

  // 语义类型（来自视觉计划）与场景关联（来自 Director 的确定性场景构建）
  const semanticByBlock = new Map<string, string>();
  for (const item of visual.items) {
    if (item.narrationBlockId !== null) semanticByBlock.set(item.narrationBlockId, item.semanticType);
  }
  const { policy } = resolveDirectorPolicy();
  const directed = buildDirectorScenes({ plan, visual, policy });
  const sceneIdByBlock = new Map<string, string>();
  for (const scene of directed.scenes) {
    for (const blockId of scene.narrationBlockIds) sceneIdByBlock.set(blockId, scene.sceneId);
  }

  const { segments, warnings: segmentWarnings } = buildSpeechSegments({
    blocks: plan.narrationBlocks,
    semanticByBlock,
    profile: profileFields,
    ...(input.styleOverrides !== undefined ? { styleOverrides: input.styleOverrides } : {}),
    sceneIdByBlock,
  });
  warnings.push(...segmentWarnings);

  const lockedSegments = segments.filter((segment) => segment.locked);
  if (lockedSegments.length > 0) {
    warnings.push({
      code: SPEECH_WARNING_CODES.LOCKED_PRESERVED,
      severity: 'INFO',
      message: `${String(lockedSegments.length)} 个锁定旁白段逐字用于合成文本（不得改写）`,
      segmentId: null,
    });
  }

  // Provider 能力核验（Router）：无可用 TTS → 风格参数支持情况未核验（不冒充可合成）
  try {
    const route = await resolveProviderRoute(deps, { workspaceId: input.workspaceId, capability: 'speech.synthesize' });
    if (route.decision === null) {
      warnings.push({ code: SPEECH_WARNING_CODES.STYLE_SUPPORT_UNVERIFIED, severity: 'WARNING', message: '没有可用 TTS Provider：风格参数（停顿/强调/发音覆盖）支持情况未核验，合成时由 Adapter 按能力映射或降级', segmentId: null });
    }
  } catch (error) {
    if (error instanceof ApiFailure && error.code === ERROR_CODES.CAPABILITY_UNAVAILABLE) {
      warnings.push({ code: SPEECH_WARNING_CODES.STYLE_SUPPORT_UNVERIFIED, severity: 'WARNING', message: '没有可用 TTS Provider（未核验/无凭据）：风格参数支持情况未核验，合成时由 Adapter 按能力映射或降级', segmentId: null });
    } else {
      throw error;
    }
  }

  const expectedDurationMs = segments.reduce((sum, segment) => sum + segment.expectedDurationMs, 0);
  const targetDurationMs = project.targetDurationMs;
  if (targetDurationMs !== null && targetDurationMs > 0) {
    const deviation = Math.abs(expectedDurationMs - targetDurationMs) / targetDurationMs;
    if (deviation > 0.25) {
      warnings.push({
        code: SPEECH_WARNING_CODES.TARGET_DURATION_DEVIATION,
        severity: 'INFO',
        message: `预计时长 ${(expectedDurationMs / 1000).toFixed(1)}s 与目标 ${(targetDurationMs / 1000).toFixed(1)}s 偏差 ${(deviation * 100).toFixed(0)}%（真实时长由 Master Narration 对齐决定）`,
        segmentId: null,
      });
    }
  }

  const roleCounts = new Map<SpeechSceneRole, number>();
  for (const segment of segments) roleCounts.set(segment.sceneRole, (roleCounts.get(segment.sceneRole) ?? 0) + 1);
  const roleText = [...roleCounts.entries()].map(([role, count]) => `${role} ${String(count)}`).join('、');
  const voiceText = voice.voiceIdentityId === null ? '未绑定声音身份' : `声音身份 ${voice.voiceIdentityId.slice(-8)}（v${String(voice.voiceIdentityVersion)}）`;
  const decisionSummary =
    `共 ${String(segments.length)} 段（${roleText}）；预计时长 ${(expectedDurationMs / 1000).toFixed(1)}s；` +
    `${voiceText}；风格档案：${speechProfileRef.source}${speechProfileRef.id === null ? '（系统默认）' : `（v${String(speechProfileRef.version)}）`}；` +
    `告警 ${String(warnings.length)} 条。`;

  return speechPlanSchema.parse({
    schemaVersion: '0.1',
    speechPlanVersion: SPEECH_PLAN_VERSION,
    projectId: input.projectId,
    narrativePlanId: plan.id,
    narrativePlanRevision: plan.revision,
    voice,
    speechProfile: speechProfileRef,
    targetDurationMs,
    expectedDurationMs,
    segments,
    warnings,
    decisionSummary,
    generation: { method: 'DETERMINISTIC', modelVersion: null, promptVersion: null },
  });
}
