import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  STRATEGY_ERROR_REASONS,
  strategyPackSchema,
  strategyPackSummarySchema,
  type StrategyKnobValues,
  type StrategyPack,
  type StrategyPackSummary,
} from '@ancs/contracts';
import { strategyPacks } from '@ancs/db';
import type { DomainDeps } from './deps.js';

/**
 * V6 §6.6 策略剪辑（可选功能）。
 *
 * 策略包只是**数据**：选用后把要点作为风格参考交给 AI；这里没有任何按策略或类型分支的执行逻辑，
 * 不缩小工具目录，不绕过通用自检（裁决 0018）。内置预设是少量手写的数据；
 * 工作区自己的包（蒸馏 / 用户编辑）存 `strategy_packs`。
 */

const travelRubricBase = [
  { key: 'place_established', criterion: 'The opening tells the viewer where we are within the first seconds.', weight: 2 },
  { key: 'intentional_ending', criterion: 'The ending is intentional (a closing image or moment), not an abrupt stop.', weight: 1 },
];

export const BUILT_IN_STRATEGY_PACKS: readonly StrategyPack[] = [
  strategyPackSchema.parse({
    id: 'builtin:travel-documentary',
    version: 1,
    kind: 'BUILT_IN',
    genre: 'travel',
    name: { 'zh-CN': '旅行纪实', en: 'Travel documentary' },
    summary: {
      'zh-CN': '舒缓、有呼吸感的旅行纪实：先交代环境，再到细节和人，在最好的景色上停留，结尾收在远景或日落。',
      en: 'A calm travel film with room to breathe: establish the place, move to details and people, linger on the best views, end on a wide shot or sunset.',
    },
    knobs: [
      {
        key: 'pacing', label: { 'zh-CN': '节奏', en: 'Pacing' }, defaultValue: 'default',
        options: [
          { value: 'slower', label: { 'zh-CN': '更慢', en: 'Slower' }, guidance: 'Lean to the long end of the shot-length range (4-6 s) and hold the highlight longer.' },
          { value: 'default', label: { 'zh-CN': '默认', en: 'Default' }, guidance: 'Use the shot-length range as given.' },
          { value: 'faster', label: { 'zh-CN': '更快', en: 'Faster' }, guidance: 'Lean to the short end of the range (2-3 s) while keeping the calm structure.' },
        ],
      },
      {
        key: 'sound', label: { 'zh-CN': '声音', en: 'Sound' }, defaultValue: 'natural',
        options: [
          { value: 'natural', label: { 'zh-CN': '多留现场声', en: 'More natural sound' }, guidance: 'Keep natural sound and short real-sound moments audible; music stays underneath.' },
          { value: 'music', label: { 'zh-CN': '音乐为主', en: 'Music forward' }, guidance: 'Let music lead; bring natural sound up only for a few key moments.' },
        ],
      },
    ],
    editingDna: {
      shotSeconds: { typical: { min: 2.5, max: 5.5 }, median: 3.5 },
      beatCutRatio: 0.2,
      shotScaleVariety: 0.6,
      transitionsPerMinute: 1,
      speedRampsPerMinute: 0,
      zoomsPerMinute: 0.5,
      hookSeconds: 4,
      captionStyle: 'Sparse place-name lower thirds',
      soundHabits: 'Natural ambience under light music; keep short real-sound moments',
      colorTendency: 'Consistent, natural, slightly warm grade',
    },
    structureHints: [
      'Establish: one to three wide shots that say where we are',
      'Details: textures, food, hands, signs',
      'People: faces and interactions, with their real sound',
      'Highlight: the best view or moment, allowed to run 4-6 s',
      'Close: a wide shot, sunset or departure; let the last shot breathe',
    ],
    agentGuidance: 'Style reference chosen by the user: calm travel documentary. Favor steady shots of about 2.5-5.5 s, wide-to-close progressions inside each place, short natural-sound moments between music phrases, and few transitions (hard cuts; a dissolve only at a change of place or time). Let the single best view run longer. End on a wide or sunset shot.',
    styleRubric: [
      ...travelRubricBase,
      { key: 'steady_pacing', criterion: 'Most shots are 2.5-5.5 s; no stretch of rapid-fire cutting.', weight: 2 },
      { key: 'natural_sound', criterion: 'At least one moment where real sound carries the scene.', weight: 1 },
      { key: 'highlight_dwell', criterion: 'The strongest view is held noticeably longer than the average shot.', weight: 1 },
    ],
    source: null,
  }),
  strategyPackSchema.parse({
    id: 'builtin:travel-beat',
    version: 1,
    kind: 'BUILT_IN',
    genre: 'travel',
    name: { 'zh-CN': '节奏卡点', en: 'Beat montage' },
    summary: {
      'zh-CN': '快节奏的卡点混剪：3 秒内用最抓人的画面开场，镜头随节拍切换、景别不断交替，能量一路推到高潮，干脆收尾。',
      en: 'A fast, beat-driven montage: open with the most striking shot within 3 seconds, cut on the beat, keep changing shot scale, build to a peak and end crisply.',
    },
    knobs: [
      {
        key: 'pacing', label: { 'zh-CN': '节奏', en: 'Pacing' }, defaultValue: 'default',
        options: [
          { value: 'calmer', label: { 'zh-CN': '稍缓', en: 'Calmer' }, guidance: 'Use shots of about 1.5-2.5 s; cut on every second beat.' },
          { value: 'default', label: { 'zh-CN': '默认', en: 'Default' }, guidance: 'Use the shot-length range as given.' },
          { value: 'intense', label: { 'zh-CN': '更密', en: 'Intense' }, guidance: 'Use shots of about 0.4-1 s in the build and peak.' },
        ],
      },
      {
        key: 'transitions', label: { 'zh-CN': '转场', en: 'Transitions' }, defaultValue: 'hard_cuts',
        options: [
          { value: 'hard_cuts', label: { 'zh-CN': '只用硬切', en: 'Hard cuts only' }, guidance: 'Hard cuts only; energy comes from rhythm and shot scale.' },
          { value: 'some_effects', label: { 'zh-CN': '加一些转场', en: 'Some transitions' }, guidance: 'A few quick motion transitions at section changes, never more than one every 8 s.' },
        ],
      },
    ],
    editingDna: {
      shotSeconds: { typical: { min: 0.5, max: 2 }, median: 1.1 },
      beatCutRatio: 0.8,
      shotScaleVariety: 0.9,
      transitionsPerMinute: 4,
      speedRampsPerMinute: 2,
      zoomsPerMinute: 3,
      hookSeconds: 3,
      captionStyle: 'Minimal or none',
      soundHabits: 'Music-driven; cut points on beats and downbeats',
      colorTendency: 'Punchy, higher contrast',
    },
    structureHints: [
      'Hook (0-3 s): the most striking shot',
      'Build: alternate wide, medium and close on the beat',
      'Peak: the best action on the strongest section of the music',
      'Out: one final strong image, ending on a downbeat',
    ],
    agentGuidance: 'Style reference chosen by the user: fast beat-driven travel montage. Keep shots short (about 0.5-2 s), place cut points on music beats when beat analysis is available (otherwise keep a regular rhythm), alternate shot scale constantly, open with the most striking shot within 3 seconds and build toward the strongest moment. Do not cut inside a spoken sentence when speech matters. With few usable shots, prefer fewer clean cuts over repeating shots.',
    styleRubric: [
      ...travelRubricBase,
      { key: 'fast_hook', criterion: 'A striking shot appears within the first 3 seconds.', weight: 2 },
      { key: 'beat_alignment', criterion: 'Most cut points fall on music beats when music is present.', weight: 2 },
      { key: 'scale_variety', criterion: 'Consecutive shots rarely share the same shot scale.', weight: 1 },
    ],
    source: null,
  }),
];

const summaryOf = (pack: StrategyPack, createdAt: Date | null): StrategyPackSummary => strategyPackSummarySchema.parse({
  id: pack.id, version: pack.version, kind: pack.kind, genre: pack.genre, name: pack.name, summary: pack.summary, knobs: pack.knobs,
  createdAt: createdAt?.toISOString() ?? null,
});

/** 可选的策略：内置预设 + 本工作区的包（新 → 旧）。 */
export async function listStrategyPacks(deps: DomainDeps, input: { workspaceId: string }): Promise<StrategyPackSummary[]> {
  const rows = await deps.db.select().from(strategyPacks)
    .where(and(eq(strategyPacks.workspaceId, input.workspaceId), isNull(strategyPacks.deletedAt)))
    .orderBy(desc(strategyPacks.createdAt));
  return [
    ...BUILT_IN_STRATEGY_PACKS.map((pack) => summaryOf(pack, null)),
    ...rows.map((row) => summaryOf(strategyPackSchema.parse(row.pack), row.createdAt)),
  ];
}

export async function getStrategyPack(deps: DomainDeps, input: { workspaceId: string; packId: string }): Promise<StrategyPack> {
  const builtIn = BUILT_IN_STRATEGY_PACKS.find((pack) => pack.id === input.packId);
  if (builtIn !== undefined) return builtIn;
  const rows = await deps.db.select().from(strategyPacks)
    .where(and(eq(strategyPacks.id, input.packId), eq(strategyPacks.workspaceId, input.workspaceId), isNull(strategyPacks.deletedAt))).limit(1);
  const row = rows[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'strategy pack not found', 404, { reason: STRATEGY_ERROR_REASONS.NOT_FOUND });
  return strategyPackSchema.parse(row.pack);
}

/** 旋钮取值：只接受包里声明的键与值；缺省用默认值。 */
export function resolveStrategyKnobs(pack: StrategyPack, knobs: StrategyKnobValues): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(knobs)) {
    const knob = pack.knobs.find((candidate) => candidate.key === key);
    if (knob === undefined || !knob.options.some((option) => option.value === value)) {
      throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, `unknown strategy knob ${key}=${value}`, 422, { reason: STRATEGY_ERROR_REASONS.INVALID_KNOB, key, value });
    }
  }
  for (const knob of pack.knobs) resolved[knob.key] = knobs[knob.key] ?? knob.defaultValue;
  return resolved;
}

const range = (min: number, max: number, unit: string): string => `${String(min)}-${String(max)} ${unit}`;

/** 给 AI 的风格参考（英文；与通用系统提示分开，作为数据块进入本轮上下文）。 */
export function strategyGuidanceText(pack: StrategyPack, knobs: Record<string, string>): string {
  const dna = pack.editingDna;
  const dnaLines = [
    `shot length typically ${range(dna.shotSeconds.typical.min, dna.shotSeconds.typical.max, 's')}${dna.shotSeconds.median === null ? '' : ` (median ${String(dna.shotSeconds.median)} s)`}`,
    dna.beatCutRatio === null ? null : `about ${String(Math.round(dna.beatCutRatio * 100))}% of cuts on music beats`,
    dna.shotScaleVariety === null ? null : `shot-scale variety ${String(dna.shotScaleVariety)} (0 = rarely changes, 1 = changes every shot)`,
    dna.transitionsPerMinute === null ? null : `${String(dna.transitionsPerMinute)} non-cut transitions per minute`,
    dna.speedRampsPerMinute === null ? null : `${String(dna.speedRampsPerMinute)} speed ramps per minute`,
    dna.zoomsPerMinute === null ? null : `${String(dna.zoomsPerMinute)} punch-ins or zooms per minute`,
    dna.hookSeconds === null ? null : `opening hook within ${String(dna.hookSeconds)} s`,
    dna.captionStyle === null ? null : `captions: ${dna.captionStyle}`,
    dna.soundHabits === null ? null : `sound: ${dna.soundHabits}`,
    dna.colorTendency === null ? null : `color: ${dna.colorTendency}`,
    dna.cutsPerMinute === null ? null : `about ${String(dna.cutsPerMinute)} cuts per minute on average`,
    dna.pacing === null ? null : `pacing curve (cuts per minute in each tenth of the video): ${dna.pacing.map((value) => String(value)).join(', ')}`,
    dna.measured === null ? null : `measured from ${String(dna.measured.references)} reference video(s), ${String(Math.round(dna.measured.analyzedSeconds))} s, ${String(dna.measured.shots)} shots`,
  ].filter((line): line is string => line !== null);
  const knobLines = pack.knobs.map((knob) => {
    const value = knobs[knob.key] ?? knob.defaultValue;
    const option = knob.options.find((candidate) => candidate.value === value);
    return `- ${knob.key} = ${value}: ${option?.guidance ?? ''}`;
  });
  return [
    `${pack.name.en} (${pack.kind.toLowerCase().replace('_', '-')} strategy v${String(pack.version)}). This is optional style reference, not a template: the footage and the person's request come first; say briefly where you diverge.`,
    pack.agentGuidance,
    'Structure hints:',
    ...pack.structureHints.map((hint) => `- ${hint}`),
    'Editing DNA targets:',
    ...dnaLines.map((line) => `- ${line}`),
    ...(knobLines.length === 0 ? [] : ['Settings chosen by the person:', ...knobLines]),
    'Style fit is checked against:',
    ...pack.styleRubric.map((item) => `- ${item.criterion}`),
    ...(pack.source?.confidenceNote ? [`Confidence: ${pack.source.confidenceNote}`] : []),
  ].join('\n');
}

/** 默认的策略要点端口（Agent 运行时用）：找不到包时返回 null（轮次照常，不带策略）。 */
export async function defaultStrategyGuidance(deps: DomainDeps, input: { workspaceId: string; strategyPackId: string; knobs: Record<string, string> }): Promise<string | null> {
  try {
    const pack = await getStrategyPack(deps, { workspaceId: input.workspaceId, packId: input.strategyPackId });
    return strategyGuidanceText(pack, resolveStrategyKnobs(pack, input.knobs));
  } catch (error) {
    if (error instanceof ApiFailure && error.httpStatus < 500) return null;
    throw error;
  }
}

/** 保存工作区自己的策略包（蒸馏 / 用户编辑；V6-6 使用）。 */
export async function saveStrategyPack(deps: DomainDeps, input: { workspaceId: string; pack: Omit<StrategyPack, 'id'> & { id?: string }; createdBy?: string | null }): Promise<StrategyPack> {
  if (input.pack.kind === 'BUILT_IN') throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'built-in strategy packs are not stored', 422);
  const pack = strategyPackSchema.parse({ ...input.pack, id: input.pack.id ?? `stp_${randomUUID()}` });
  await deps.db.insert(strategyPacks).values({
    id: pack.id, workspaceId: input.workspaceId, kind: pack.kind, version: pack.version, genre: pack.genre, pack, createdBy: input.createdBy ?? null,
  }).onConflictDoUpdate({ target: strategyPacks.id, set: { version: pack.version, genre: pack.genre, pack, updatedAt: new Date() }, setWhere: eq(strategyPacks.workspaceId, input.workspaceId) });
  return pack;
}
