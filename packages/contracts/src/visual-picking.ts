import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import {
  hitTestVisualObject,
  invertVisualPoint,
  projectVisualPoint,
  visualCropSchema,
  visualTransformSchema,
  type VisualPoint,
  type VisualViewport,
} from './visual-transform.js';

/**
 * N04-02-s1：画布原生对象**命中与点选**的权威层（增量设计 §3.1、§4.2）。
 *
 * 纪律：
 * - 复用既有 `hitTestVisualObject` / `invertVisualPoint` / `projectVisualPoint`，不新建第二套坐标公式；
 * - 身份来自 `objectId` 与其版本，**预览帧号/帧哈希不是身份也不是授权**；
 * - 命中重叠对象时优先**可见的细粒度对象**（VISUAL_OBJECT 先于 CLIP），并允许轮换候选，
 *   永远命中最外层 Scene 是错误行为；
 * - 隐藏对象（自身或父对象隐藏）不参与命中；结果顺序确定（zOrder 降序 → 细粒度优先 → 输入顺序）。
 */

export const VISUAL_HIT_TARGET_KINDS = ['CLIP', 'VISUAL_OBJECT'] as const;
export const visualHitTargetKindSchema = z.enum(VISUAL_HIT_TARGET_KINDS);
export type VisualHitTargetKind = z.infer<typeof visualHitTargetKindSchema>;

export const visualHitTargetSchema = z
  .object({
    objectId: opaqueIdSchema,
    /** 命中对象所属片段（真实视频像素区域使用；结构化覆盖层可为 null）。 */
    clipId: opaqueIdSchema.nullable().default(null),
    targetKind: visualHitTargetKindSchema,
    /** 可见即可选的版本语义（采用绑定用）。 */
    assetVersionId: opaqueIdSchema.nullable().default(null),
    transform: visualTransformSchema,
    crop: visualCropSchema,
    /** 自身可见性（与父对象可见性都为真才参与命中）。 */
    visible: z.boolean().default(true),
    /** 同层叠放顺序（越大越靠上）。 */
    zOrder: z.number().int().default(0),
    /** 父对象（父隐藏则子不参与命中；不支持环）。 */
    parentObjectId: opaqueIdSchema.nullable().default(null),
  })
  .strict();

export type VisualHitTarget = z.infer<typeof visualHitTargetSchema>;

const KIND_RANK: Record<VisualHitTargetKind, number> = { VISUAL_OBJECT: 0, CLIP: 1 };

/**
 * 命中点 → 候选对象（从最上层到最下层）。
 * 输入应为已解析的规范对象；此处**不做 zod 解析**以保证指针高频路径的本地性能。
 */
export function pickVisualObjects(input: {
  point: VisualPoint;
  viewport: VisualViewport;
  targets: readonly VisualHitTarget[];
}): VisualHitTarget[] {
  const visibility = new Map<string, boolean>();
  for (const target of input.targets) visibility.set(target.objectId, target.visible);

  const hits: { target: VisualHitTarget; index: number }[] = [];
  input.targets.forEach((target, index) => {
    if (!target.visible) return;
    if (target.parentObjectId !== null && visibility.get(target.parentObjectId) === false) return;
    const hit = hitTestVisualObject({
      point: input.point,
      transform: target.transform,
      crop: target.crop,
      viewport: input.viewport,
    });
    if (hit) hits.push({ target, index });
  });

  return hits
    .sort((left, right) => {
      if (right.target.zOrder !== left.target.zOrder) return right.target.zOrder - left.target.zOrder;
      const rank = KIND_RANK[left.target.targetKind] - KIND_RANK[right.target.targetKind];
      if (rank !== 0) return rank;
      return left.index - right.index;
    })
    .map((entry) => entry.target);
}

/** 仅取最上层命中（点击默认结果）。 */
export function topmostVisualObject(input: {
  point: VisualPoint;
  viewport: VisualViewport;
  targets: readonly VisualHitTarget[];
}): VisualHitTarget | null {
  return pickVisualObjects(input)[0] ?? null;
}

/**
 * 重叠对象轮换：在同一点命中的候选里，从当前选中对象切到下一个（列表末尾回到第一个）。
 * 当前对象不在候选里时返回第一个候选；无候选返回 null。
 */
export function cycleVisualCandidate(
  candidates: readonly VisualHitTarget[],
  currentObjectId: string | null,
): VisualHitTarget | null {
  if (candidates.length === 0) return null;
  if (currentObjectId === null) return candidates[0]!;
  const index = candidates.findIndex((candidate) => candidate.objectId === currentObjectId);
  if (index === -1) return candidates[0]!;
  return candidates[(index + 1) % candidates.length]!;
}

/**
 * 投影对象在画布上的可见四边形（用于覆盖层绘制）。
 * 顺序：左上、右上、右下、左下（归一化局部坐标 → 画布像素）。
 */
export function projectVisualQuad(input: {
  transform: VisualHitTarget['transform'];
  crop: VisualHitTarget['crop'];
  viewport: VisualViewport;
}): VisualPoint[] {
  const corners: VisualPoint[] = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];
  return corners.map((point) =>
    projectVisualPoint({ point, transform: input.transform, crop: input.crop, viewport: input.viewport }),
  );
}

/** 画布坐标 → 对象局部归一化坐标（供测试/调试；与命中检测同源）。 */
export function localPointFor(input: {
  point: VisualPoint;
  transform: VisualHitTarget['transform'];
  crop: VisualHitTarget['crop'];
  viewport: VisualViewport;
}): VisualPoint {
  return invertVisualPoint(input);
}
