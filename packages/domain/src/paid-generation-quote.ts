import { and, desc, eq } from 'drizzle-orm';
import {
  MICROS_PER_CREDIT,
  generationBudgetSchema,
  generationSchema,
  type Generation,
  type GenerationBudget,
  type GenerationKind,
  type GenerationOffer,
} from '@ancs/contracts';
import { budgetCounters, generationRequests } from '@ancs/db';
import { getBudget, periodKey } from './billing.js';
import type { DomainDeps } from './deps.js';

/**
 * V6-7 / V6-8 付费生成的报价与读面（纯计算 + 读取；不触发生成，不依赖 Agent 运行时）。
 * 报价 = 时长区间 × 供应商声明的每秒价格区间；确认时按上限预留预算。
 */

/** 生成画面尺寸（按工程画幅；720p 级别，供应商常见规格）。 */
const GENERATION_CANVAS: Readonly<Record<string, { width: number; height: number }>> = {
  '16:9': { width: 1280, height: 720 },
  '9:16': { width: 720, height: 1280 },
  '1:1': { width: 1080, height: 1080 },
  '4:5': { width: 864, height: 1080 },
};

export function generationCanvas(aspectRatio: string): { width: number; height: number } {
  return GENERATION_CANVAS[aspectRatio] ?? GENERATION_CANVAS['16:9']!;
}

/** 金额显示（微美元 → "$0.62"）。只用于说明文字，不参与结算。 */
export function formatMicros(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

const CJK_LANGUAGES = new Set(['zh', 'ja', 'ko']);

/** 讲稿预计时长（秒，一位小数）：中日韩按字（约 4.5 字/秒），其他按词（约 2.6 词/秒），外加 0.6 秒起止留白。 */
export function estimateSpeechSeconds(script: string, language: string): number {
  const cjk = CJK_LANGUAGES.has(language);
  const units = cjk
    ? [...script].filter((character) => /[\p{L}\p{N}]/u.test(character)).length
    : script.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
  return Math.max(1, Math.round((units / (cjk ? 4.5 : 2.6) + 0.6) * 10) / 10);
}

export interface GenerationQuote {
  /** 产物时长区间（秒）：数字人按讲稿语速浮动（0.8–1.3 倍，上限不超过供应商单次上限）；其他就是请求的时长 */
  minSeconds: number;
  maxSeconds: number;
  minMicros: number;
  maxMicros: number;
  /** 确认时预留的 Credits（报价上限向上取整） */
  reserveCredits: number;
}

export function quoteGeneration(offer: GenerationOffer, kind: GenerationKind, seconds: number): GenerationQuote {
  const minSeconds = kind === 'AVATAR_CLIP' ? Math.round(seconds * 0.8 * 10) / 10 : seconds;
  const maxSeconds = kind === 'AVATAR_CLIP' ? Math.min(offer.maxSeconds, Math.round(seconds * 1.3 * 10) / 10) : seconds;
  const minMicros = Math.ceil(minSeconds * offer.perSecondMicros.min);
  const maxMicros = Math.ceil(maxSeconds * offer.perSecondMicros.max);
  return { minSeconds, maxSeconds, minMicros, maxMicros, reserveCredits: Math.ceil(maxMicros / MICROS_PER_CREDIT) };
}

export type GenerationRow = typeof generationRequests.$inferSelect;

export function toGeneration(row: GenerationRow, now: Date = new Date()): Generation {
  const expired = row.status === 'QUOTED' && row.expiresAt.getTime() <= now.getTime();
  return generationSchema.parse({
    id: row.id,
    projectId: row.projectId,
    sessionId: row.sessionId,
    kind: row.kind,
    status: expired ? 'EXPIRED' : row.status,
    request: row.request,
    summary: row.summary,
    providerId: row.providerId,
    implementation: row.providerImplementation,
    model: row.model,
    estimatedSeconds: row.estimatedSeconds,
    estimate: { minMicros: row.estimateMinMicros, maxMicros: row.estimateMaxMicros },
    reserveCredits: row.reserveCredits,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    chargedMicros: row.chargedMicros,
    costSource: row.costSource,
    quoteTurnId: row.quoteTurnId,
    turnId: row.turnId,
    proposalId: row.proposalId,
    footageId: row.footageId,
    outsideRegionChange: row.outsideRegionChange,
    error: row.error === null ? null : { reason: String((row.error as { reason?: unknown }).reason ?? 'UNKNOWN'), message: String((row.error as { message?: unknown }).message ?? '') },
  });
}

export async function listProjectGenerations(deps: DomainDeps, input: { workspaceId: string; projectId: string; limit?: number }): Promise<Generation[]> {
  const rows = await deps.db.select().from(generationRequests)
    .where(and(eq(generationRequests.workspaceId, input.workspaceId), eq(generationRequests.projectId, input.projectId)))
    .orderBy(desc(generationRequests.createdAt)).limit(Math.min(input.limit ?? 20, 100));
  const now = new Date();
  return rows.map((row) => toGeneration(row, now));
}

/** 工作区生成预算概况（单位换算成微美元；未设置或上限为 0 = 未配置，付费生成会被拒绝）。 */
export async function generationBudget(deps: DomainDeps, input: { workspaceId: string; now?: Date }): Promise<GenerationBudget> {
  const budget = await getBudget(deps, { workspaceId: input.workspaceId });
  const period = budget?.period ?? 'MONTHLY';
  const key = periodKey(period, input.now ?? new Date());
  const counter = (await deps.db.select().from(budgetCounters)
    .where(and(eq(budgetCounters.workspaceId, input.workspaceId), eq(budgetCounters.periodKey, key))).limit(1))[0];
  const configured = budget !== null && budget.limitCredits > 0;
  return generationBudgetSchema.parse({
    configured,
    period: budget === null ? null : budget.period,
    limitMicros: configured ? budget.limitCredits * MICROS_PER_CREDIT : null,
    spentMicros: (counter?.spentCredits ?? 0) * MICROS_PER_CREDIT,
    reservedMicros: (counter?.reservedCredits ?? 0) * MICROS_PER_CREDIT,
  });
}
