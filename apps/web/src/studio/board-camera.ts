'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

/**
 * 无限画布的镜头（参照 Stitch）：世界坐标里摆着成片屏幕与素材、计划、文章等画框，镜头决定看哪一块、放多大。
 * 屏幕坐标 = 世界坐标 × k + (x, y)。纯函数部分（适配、以某点为中心缩放、平移、滚轮）单独导出便于测试；
 * 钩子只负责尺寸观察与指针 / 滚轮事件。时间带、语音条、工具条不在世界里（不随镜头缩放），它们的测量不受影响。
 */

export interface Camera { x: number; y: number; k: number }
export interface Rect { x: number; y: number; width: number; height: number }
export interface Size { width: number; height: number }
export interface Insets { top: number; right: number; bottom: number; left: number }

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;
const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

export const clampZoom = (k: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

/** 让目标区域完整落在视口（扣掉留白）里并居中；不放大超过 1:1 的 maxZoom（缺省 1） */
export function fitCamera(view: Size, target: Rect, insets: Insets = NO_INSETS, maxZoom = 1): Camera {
  const width = Math.max(1, view.width - insets.left - insets.right);
  const height = Math.max(1, view.height - insets.top - insets.bottom);
  if (target.width <= 0 || target.height <= 0) return { x: insets.left, y: insets.top, k: 1 };
  const k = clampZoom(Math.min(width / target.width, height / target.height, maxZoom));
  return {
    k,
    x: insets.left + (width - target.width * k) / 2 - target.x * k,
    y: insets.top + (height - target.height * k) / 2 - target.y * k,
  };
}

/** 以屏幕上的一点为中心缩放（那一点下的世界位置保持不动） */
export function zoomAt(camera: Camera, point: { x: number; y: number }, factor: number): Camera {
  const k = clampZoom(camera.k * factor);
  const ratio = k / camera.k;
  return { k, x: point.x - (point.x - camera.x) * ratio, y: point.y - (point.y - camera.y) * ratio };
}

export const panBy = (camera: Camera, dx: number, dy: number): Camera => ({ ...camera, x: camera.x + dx, y: camera.y + dy });

/**
 * 滚轮：按住 Ctrl / ⌘（触控板双指捏合也带 ctrlKey）缩放，否则平移（触控板双指滑动）。
 * deltaMode 1 = 行、2 = 页，换算成像素。
 */
export function wheelCamera(camera: Camera, event: { deltaX: number; deltaY: number; deltaMode: number; ctrlKey: boolean; metaKey: boolean }, point: { x: number; y: number }): Camera {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
  const dx = event.deltaX * unit;
  const dy = event.deltaY * unit;
  if (event.ctrlKey || event.metaKey) return zoomAt(camera, point, Math.exp(-dy * 0.0025 * (unit === 1 ? 1 : 4)));
  return panBy(camera, -dx, -dy);
}

/** 世界里的点 → 屏幕（视口内）坐标 */
export const toScreen = (camera: Camera, point: { x: number; y: number }): { x: number; y: number } => ({ x: point.x * camera.k + camera.x, y: point.y * camera.k + camera.y });

/** 世界里的区域合并成一个外框 */
export function unionRect(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

type Follow = 'all' | 'monitor' | null;

/** 指针是不是落在画布空白处（画框里、按钮、输入框上的操作不平移） */
function onBackground(target: EventTarget | null, viewport: HTMLElement): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('[data-board-frame], button, a, input, textarea, select, video, [role="application"]') !== null) return false;
  return viewport.contains(target);
}

/**
 * 镜头钩子：enabled=false 时（手机一列布局）不接管任何事件、不变换。
 * 初始与视口变化时跟随"看全部"（或"只看成片"）；用户自己平移 / 缩放后不再自动适配，直到再点适配按钮。
 */
export function useBoardCamera(viewportRef: RefObject<HTMLElement | null>, options: { enabled: boolean; all: Rect | null; monitor: Rect; insets: Insets; initial: Exclude<Follow, null> }) {
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, k: 1 });
  const [view, setView] = useState<Size>({ width: 0, height: 0 });
  const [follow, setFollow] = useState<Follow>(options.initial);
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const { enabled, all, monitor, insets } = options;
  const allKey = all === null ? '' : `${all.x},${all.y},${all.width},${all.height}`;
  const monitorKey = `${monitor.x},${monitor.y},${monitor.width},${monitor.height}`;
  const insetsKey = `${insets.top},${insets.right},${insets.bottom},${insets.left}`;

  useEffect(() => {
    const element = viewportRef.current;
    if (element === null) return;
    const update = () => setView({ width: element.clientWidth, height: element.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [viewportRef]);

  // 跟随适配：视口、内容或留白变化时重新适配
  useEffect(() => {
    if (!enabled || follow === null || view.width === 0 || view.height === 0) return;
    const target = follow === 'all' ? all ?? monitor : monitor;
    // 只有成片屏幕时允许放大到 1.25 倍铺满画布；带着画框时不超过 1:1
    setCamera(fitCamera(view, target, insets, target === monitor ? 1.25 : 1));
    // 依据各自的数值键（对象每次渲染都是新的）
  }, [enabled, follow, view.width, view.height, allKey, monitorKey, insetsKey]);

  const manual = useCallback((next: (current: Camera) => Camera) => {
    setFollow(null);
    setCamera((current) => next(current));
  }, []);

  // 滚轮（非被动：要阻止页面滚动 / 浏览器缩放）与指针平移、双指捏合
  useEffect(() => {
    const element = viewportRef.current;
    if (element === null || !enabled) return;
    const local = (clientX: number, clientY: number) => {
      const rect = element.getBoundingClientRect();
      return { x: clientX - rect.left, y: clientY - rect.top };
    };
    const onWheel = (event: WheelEvent) => {
      if (event.target instanceof Element && event.target.closest('[data-board-scroll]') !== null && !event.ctrlKey && !event.metaKey) return; // 画框里可滚动的列表自己滚
      event.preventDefault();
      const point = local(event.clientX, event.clientY);
      manual((current) => wheelCamera(current, event, point));
    };
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch: { distance: number; mid: { x: number; y: number } } | null = null;
    const pinchState = () => {
      const [a, b] = [...pointers.values()];
      if (a === undefined || b === undefined) return null;
      return { distance: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
    };
    const onDown = (event: PointerEvent) => {
      const middle = event.button === 1;
      if (!middle && !(event.button === 0 && onBackground(event.target, element))) return;
      event.preventDefault();
      element.setPointerCapture?.(event.pointerId);
      pointers.set(event.pointerId, local(event.clientX, event.clientY));
      pinch = pointers.size === 2 ? pinchState() : null;
      element.dataset['panning'] = 'true';
    };
    const onMove = (event: PointerEvent) => {
      const previous = pointers.get(event.pointerId);
      if (previous === undefined) return;
      const point = local(event.clientX, event.clientY);
      pointers.set(event.pointerId, point);
      if (pointers.size === 2 && pinch !== null) {
        const next = pinchState();
        if (next === null || pinch.distance === 0) return;
        const before = pinch;
        manual((current) => panBy(zoomAt(current, before.mid, next.distance / before.distance), next.mid.x - before.mid.x, next.mid.y - before.mid.y));
        pinch = next;
        return;
      }
      manual((current) => panBy(current, point.x - previous.x, point.y - previous.y));
    };
    const onUp = (event: PointerEvent) => {
      if (!pointers.delete(event.pointerId)) return;
      pinch = pointers.size === 2 ? pinchState() : null;
      if (pointers.size === 0) delete element.dataset['panning'];
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    element.addEventListener('pointerdown', onDown);
    element.addEventListener('pointermove', onMove);
    element.addEventListener('pointerup', onUp);
    element.addEventListener('pointercancel', onUp);
    return () => {
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('pointerdown', onDown);
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('pointercancel', onUp);
    };
  }, [viewportRef, enabled, manual]);

  const center = { x: view.width / 2, y: view.height / 2 };
  const fitAll = useCallback(() => setFollow('all'), []);
  const fitMonitor = useCallback(() => setFollow('monitor'), []);
  return {
    camera,
    view,
    follow,
    fitAll,
    fitMonitor,
    zoomBy: (factor: number) => manual((current) => zoomAt(current, center, factor)),
    /** 把镜头移到一块区域（剪辑师正在看的地方）：只平移，不改缩放；区域已在视口内时不动 */
    reveal: (rect: Rect) => {
      const current = cameraRef.current;
      const left = rect.x * current.k + current.x;
      const top = rect.y * current.k + current.y;
      const inside = left >= 0 && top >= 0 && left + rect.width * current.k <= view.width && top + rect.height * current.k <= view.height;
      if (inside || view.width === 0) return;
      setFollow(null);
      setCamera({ ...current, x: view.width / 2 - (rect.x + rect.width / 2) * current.k, y: view.height / 2 - (rect.y + rect.height / 2) * current.k });
    },
  };
}
