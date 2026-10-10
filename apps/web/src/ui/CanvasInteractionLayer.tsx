'use client';

import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  cycleVisualCandidate,
  pickVisualObjects,
  projectVisualQuad,
  type OrderedTargetRef,
  type VisualHitTarget,
  type VisualPoint,
  type VisualViewport,
} from '@ancs/contracts';

/**
 * N04-02-s1：画布原生对象**命中与点选覆盖层**（增量设计 §3.1、§3.4）。
 *
 * - 命中用 `pickVisualObjects`（复用既有 `hitTestVisualObject` / `projectVisualPoint`），身份是 objectId + 版本；
 * - 悬浮轻高亮、点击明确选择；重叠对象可轮换候选，不永远命中最外层；
 * - Shift/多选保留**选择顺序**（A、B…），后一次点击不无条件覆盖前一个目标；
 * - 空白处拖动 = 框选（以投影中心落入选框为准）；手势只产出 `OrderedTargetRef[]`，
 *   由父层组装 `SelectionAnchor`，选择动作永不改工程。
 */

export interface CanvasInteractionLayerProps {
  viewport: VisualViewport;
  objects: VisualHitTarget[];
  selectedObjectIds?: string[];
  multiSelect?: boolean;
  className?: string;
  onSelectionChange?: (targets: OrderedTargetRef[]) => void;
  onHoverChange?: (objectId: string | null) => void;
}

const labelForIndex = (index: number): string => {
  if (index < 26) return String.fromCharCode(65 + index);
  return String(index + 1);
};

function toTargetRef(object: VisualHitTarget, label: string): OrderedTargetRef {
  return {
    targetRef: object.objectId,
    targetKind: object.targetKind === 'CLIP' ? 'CLIP' : 'VISUAL_OBJECT',
    label,
    assetVersionId: object.assetVersionId,
  };
}

function relabel(refs: OrderedTargetRef[]): OrderedTargetRef[] {
  return refs.map((ref, index) => ({ ...ref, label: labelForIndex(index) }));
}

export function CanvasInteractionLayer({
  viewport,
  objects,
  selectedObjectIds = [],
  multiSelect = false,
  className,
  onSelectionChange,
  onHoverChange,
}: CanvasInteractionLayerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [marquee, setMarquee] = useState<{ start: VisualPoint; current: VisualPoint } | null>(null);

  const pointFromEvent = (event: { clientX: number; clientY: number }): VisualPoint => {
    const rect = containerRef.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  };

  const gatherCandidates = (point: VisualPoint): VisualHitTarget[] =>
    pickVisualObjects({ point, viewport, targets: objects });

  const commitClick = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const point = pointFromEvent(event);
    const candidates = gatherCandidates(point);
    if (candidates.length === 0) {
      if (!event.shiftKey && !multiSelect) onSelectionChange?.([]);
      return;
    }
    const additive = event.shiftKey || multiSelect;
    let chosen = candidates[0]!;
    // 重叠对象轮换：若最上层已在选择集中，切到下一个未选中的候选。
    if (selectedObjectIds.includes(chosen.objectId)) {
      const next = candidates.find((candidate) => !selectedObjectIds.includes(candidate.objectId));
      if (next !== undefined) chosen = next;
    }
    if (additive) {
      const existing = objects.filter((object) => selectedObjectIds.includes(object.objectId));
      const without = existing.filter((object) => object.objectId !== chosen.objectId);
      const nextObjects = without.length === existing.length ? [...existing, chosen] : without;
      onSelectionChange?.(relabel(nextObjects.map((object, index) => toTargetRef(object, labelForIndex(index)))));
      return;
    }
    onSelectionChange?.([toTargetRef(chosen, 'A')]);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const point = pointFromEvent(event);
    if (gatherCandidates(point).length === 0) {
      setMarquee({ start: point, current: point });
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const point = pointFromEvent(event);
    if (marquee !== null) {
      setMarquee({ start: marquee.start, current: point });
      return;
    }
    const candidate = candidatesAt(point);
    const nextId = candidate?.objectId ?? null;
    if (nextId !== hoveredId) {
      setHoveredId(nextId);
      onHoverChange?.(nextId);
    }
  };

  const candidatesAt = (point: VisualPoint): VisualHitTarget | null => gatherCandidates(point)[0] ?? null;

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (marquee !== null) {
      const minX = Math.min(marquee.start.x, marquee.current.x);
      const maxX = Math.max(marquee.start.x, marquee.current.x);
      const minY = Math.min(marquee.start.y, marquee.current.y);
      const maxY = Math.max(marquee.start.y, marquee.current.y);
      const width = maxX - minX;
      const height = maxY - minY;
      setMarquee(null);
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      if (width < 4 || height < 4) {
        if (!event.shiftKey && !multiSelect) onSelectionChange?.([]);
        return;
      }
      const inside = objects.filter((object) => {
        if (!object.visible) return false;
        // 用对象投影四角的几何中心判定是否落入选框。
        const quad = projectVisualQuad({ transform: object.transform, crop: object.crop, viewport });
        const cx = quad.reduce((sum, point) => sum + point.x, 0) / quad.length;
        const cy = quad.reduce((sum, point) => sum + point.y, 0) / quad.length;
        return cx >= minX && cx <= maxX && cy >= minY && cy <= maxY;
      });
      onSelectionChange?.(relabel(inside.map((object, index) => toTargetRef(object, labelForIndex(index)))));
      return;
    }
    commitClick(event);
  };

  const handlePointerLeave = (): void => {
    if (hoveredId !== null) {
      setHoveredId(null);
      onHoverChange?.(null);
    }
  };

  return (
    <div
      data-testid="canvas-interaction-layer"
      ref={containerRef}
      role="application"
      aria-label="画布对象选择层"
      className={`absolute inset-0 ${className ?? ''}`}
      style={{ width: `${String(viewport.width)}px`, height: `${String(viewport.height)}px` }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onPointerLeave={handlePointerLeave}
    >
      <svg
        data-testid="canvas-overlay"
        width={viewport.width}
        height={viewport.height}
        viewBox={`0 0 ${String(viewport.width)} ${String(viewport.height)}`}
        className="absolute inset-0 h-full w-full"
        aria-hidden="true"
      >
        {objects.map((object) => {
          const quad = projectVisualQuad({ transform: object.transform, crop: object.crop, viewport });
          const selected = selectedObjectIds.includes(object.objectId);
          const hovered = hoveredId === object.objectId;
          return (
            <polygon
              key={object.objectId}
              data-testid={`canvas-object-${object.objectId}`}
              points={quad.map((point) => `${String(point.x)},${String(point.y)}`).join(' ')}
              fill={selected ? 'var(--ui-bg-hover)' : 'transparent'}
              stroke={hovered || selected ? 'var(--ui-fg-primary)' : 'var(--ui-border-subtle)'}
              strokeWidth={selected ? 2 : 1}
              strokeDasharray={hovered && !selected ? '4 2' : undefined}
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
        {marquee !== null ? (
          <rect
            data-testid="canvas-marquee"
            x={Math.min(marquee.start.x, marquee.current.x)}
            y={Math.min(marquee.start.y, marquee.current.y)}
            width={Math.abs(marquee.current.x - marquee.start.x)}
            height={Math.abs(marquee.current.y - marquee.start.y)}
            fill="none"
            stroke="var(--ui-fg-primary)"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
      </svg>
    </div>
  );
}

/** 供测试/调试：在给定点取候选（与组件同源）。 */
export function candidatesAtPoint(viewport: VisualViewport, objects: VisualHitTarget[], point: VisualPoint): VisualHitTarget[] {
  return pickVisualObjects({ point, viewport, targets: objects });
}

/** 供测试/调试：重叠轮换的下一候选。 */
export function nextCandidate(viewport: VisualViewport, objects: VisualHitTarget[], point: VisualPoint, currentObjectId: string | null): VisualHitTarget | null {
  return cycleVisualCandidate(candidatesAtPoint(viewport, objects, point), currentObjectId);
}
