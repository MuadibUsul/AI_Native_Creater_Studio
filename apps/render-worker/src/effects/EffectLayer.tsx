import * as React from 'react';
import { AbsoluteFill, interpolate, random, spring, useCurrentFrame, useVideoConfig } from 'remotion';

/**
 * V6-3 特效图层：在**浏览器页面**里执行特效代码（模板或 AI 写的代码，契约与 Custom Motion 沙箱一致：
 * 纯 JS、顶层 `registerMotion({ name, component })`、只用注入的全局），输出透明背景的画面。
 *
 * 隔离（纵深）：代码先过四道门禁（静态分析/类型检查/沙箱评估/抽帧，见 apps/motion-worker）；这里再用参数遮蔽
 * 浏览器的网络、存储、DOM 与全局对象；渲染进程是独立子进程、环境变量走白名单、无凭据；
 * OS 级网络阻断属部署层（裁决 0008）。
 */

export interface EffectLayerProps {
  code: string;
  params: Record<string, unknown>;
  seed: string;
}

interface Registration { component?: (props: Record<string, unknown>) => React.ReactElement | null; name?: string }

/** 遮蔽的浏览器能力（代码里同名标识符一律是 undefined） */
const SHADOWED = [
  'window', 'self', 'globalThis', 'document', 'top', 'parent', 'frames', 'opener', 'location', 'navigator', 'history',
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'Request', 'Response', 'Headers', 'importScripts', 'Worker', 'SharedWorker',
  'ServiceWorker', 'BroadcastChannel', 'MessageChannel', 'postMessage', 'localStorage', 'sessionStorage', 'indexedDB', 'caches', 'cookieStore',
  'open', 'close', 'alert', 'confirm', 'prompt', 'setTimeout', 'setInterval', 'requestAnimationFrame', 'queueMicrotask', 'Function', 'Image',
] as const;

function evaluate(code: string, seed: string, params: Record<string, unknown>): Registration {
  const registrations: Registration[] = [];
  const injected: Record<string, unknown> = {
    registerMotion: (registration: Registration) => { registrations.push(registration); },
    React: { createElement: React.createElement, Fragment: React.Fragment, createContext: React.createContext, useContext: React.useContext },
    useState: React.useState, useMemo: React.useMemo, useRef: React.useRef, useEffect: () => undefined,
    useCurrentFrame, useVideoConfig, interpolate, spring, AbsoluteFill,
    /** 确定性随机数：同一种子同一结果（同一参数重渲得到同一画面） */
    random: (key: string | number) => random(`${seed}:${String(key)}`),
    fixtureProps: params,
    Math, JSON, Number, String, Boolean, Array, Object, isFinite, isNaN, parseFloat, parseInt,
  };
  const names = [...Object.keys(injected), ...SHADOWED];
  const values = [...Object.values(injected), ...SHADOWED.map(() => undefined)];
  // 代码已过四道门禁（模板代码在测试里同样过门禁）；这里只在遮蔽了浏览器能力的作用域里执行
  const run = new Function(...names, `"use strict";\n${code}`) as (...args: unknown[]) => void;
  run(...values);
  const registration = registrations.at(-1);
  if (registration === undefined || typeof registration.component !== 'function') throw new Error('effect code did not call registerMotion({ component })');
  return registration;
}

export const EffectLayer: React.FC<EffectLayerProps> = ({ code, params, seed }) => {
  const registration = React.useMemo(() => evaluate(code, seed, params), [code, seed, params]);
  const Component = registration.component!;
  return <AbsoluteFill style={{ backgroundColor: 'transparent' }}><Component {...params} /></AbsoluteFill>;
};
