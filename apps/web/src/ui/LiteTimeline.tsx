'use client';

import { useMemo, useState } from 'react';
import type { SceneGraph } from '@ancs/contracts';
import type { EditOperation } from '@ancs/contracts';
import { legacyMillisecondsToMediaTime, type FrameRate, type MediaTime, type TemporalSelection, type TimelineViewport } from '@ancs/contracts';
import { getComponent } from '@ancs/scene-components';
import { TimelineBand, type TimelineBandLane } from './TimelineBand';
import ui from './Monochrome.module.css';

/**
 * Lite Timeline（P05-05）：reorder / move / trim / split / duplicate / delete / replace(素材) /
 * transition / crop-scale（媒体 props）/ 音量（音轨）/ 字幕修正。
 *
 * 纪律：
 * - 所有操作**回写统一编辑协议**（operation 数组 + base/expected revisions + 幂等键）——UI 不直写 DB；
 * - props 变更前用**组件 schema 校验**（与渲染同源）；trim 只改 durationMs（startMs 由服务端按 position
 *   绝对定位，客户端不自行累加；刷新后以服务端为准）；
 * - 锁定场景的编辑会被服务端 409 拒绝 → 明确提示（不自动解锁）；
 * - 音轨/字幕在 V1 Draft 尚无数据源（P06-03 对齐后产生）——存在即可编辑，缺失显示诚实空态。
 */

export interface TimelineEditRequest {
  operations: EditOperation[];
  expectedSceneRevisions: Record<string, number>;
}

export interface LiteTimelineProps {
  graph: Pick<SceneGraph, 'projectRevision' | 'scenes' | 'captions' | 'audioTracks'>;
  /** 提交编辑（由页面接线到 SDK + 查询失效） */
  onEdit: (request: TimelineEditRequest) => void;
  /** 可选：项目资产（replace_asset 选择器） */
  assets?: { id: string; assetType: string }[];
  pending?: boolean;
  error?: { kind: string; message: string; code: string | null } | null;
  /** N04-04-s1：横向时间带（播放头 + 独立时间选区）；不提供则不渲染，保持既有行为。 */
  band?: {
    viewport: TimelineViewport;
    playhead?: MediaTime | null;
    selection?: TemporalSelection | null;
    frameRate?: FrameRate;
    onPlayheadChange?: (time: MediaTime) => void;
    onSelectionChange?: (selection: TemporalSelection | null) => void;
  };
}

const MEDIA_TYPES = new Set(['IMAGE_FULL', 'REAL_BROLL', 'HOST_FULL', 'HOST_SIDE']);

export function LiteTimeline({ graph, onEdit, assets = [], pending = false, error = null, band }: LiteTimelineProps) {
  const [splitAt, setSplitAt] = useState<Record<string, string>>({});
  const scenes = [...graph.scenes].sort((left, right) => left.position - right.position);

  /** N04-04-s1：把既有场景/字幕数据投影为时间带轨道块（v2 片段/轨道接入后由父层传入 band）。 */
  const bandLanes = useMemo<TimelineBandLane[]>(() => {
    const lanes: TimelineBandLane[] = [];
    const videoClips = scenes
      .filter((scene) => scene.durationMs > 0)
      .map((scene) => ({
        id: scene.id,
        label: scene.sceneType,
        range: {
          start: legacyMillisecondsToMediaTime(scene.startMs),
          end: legacyMillisecondsToMediaTime(scene.startMs + scene.durationMs),
        },
      }));
    if (videoClips.length > 0) lanes.push({ id: 'video', label: '视频', kind: 'VIDEO', clips: videoClips });
    const captionClips = graph.captions
      .filter((caption) => caption.durationMs > 0)
      .map((caption) => ({
        id: caption.id,
        label: caption.text.slice(0, 20),
        range: {
          start: legacyMillisecondsToMediaTime(caption.startMs),
          end: legacyMillisecondsToMediaTime(caption.startMs + caption.durationMs),
        },
      }));
    if (captionClips.length > 0) lanes.push({ id: 'captions', label: '字幕', kind: 'CAPTION', clips: captionClips });
    return lanes;
  }, [scenes, graph.captions]);
  const expected = (sceneId: string): Record<string, number> => {
    const scene = graph.scenes.find((candidate) => candidate.id === sceneId);
    return scene === undefined ? {} : { [scene.id]: scene.revision };
  };

  const move = (sceneId: string, delta: -1 | 1): void => {
    const index = scenes.findIndex((scene) => scene.id === sceneId);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= scenes.length) return;
    const order = scenes.map((scene) => scene.id);
    const moved = order[index];
    const swap = order[target];
    if (moved === undefined || swap === undefined) return;
    order[index] = swap;
    order[target] = moved;
    onEdit({ operations: [{ op: 'reorder_scenes', orderedSceneIds: order }], expectedSceneRevisions: expected(sceneId) });
  };

  const updateScene = (sceneId: string, changes: Record<string, unknown>, revision: number): void => {
    onEdit({
      operations: [{ op: 'update_scene', sceneId, changes } as EditOperation],
      expectedSceneRevisions: { [sceneId]: revision },
    });
  };

  return (
    <div data-testid="lite-timeline" className={`flex flex-col gap-4 p-4 ${ui['panel']}`}>
      <div className="flex items-center justify-between">
        <h2 className={`text-sm font-semibold ${ui['primaryText']}`}>Lite Timeline</h2>
        <span className={`text-xs ${ui['mutedText']}`}>
          共 {scenes.length} 场景 · 所有操作经编辑协议回写（含 revision 条件与幂等键）
        </span>
      </div>

      {band !== undefined ? (
        <TimelineBand
          viewport={band.viewport}
          playhead={band.playhead ?? null}
          selection={band.selection ?? null}
          lanes={bandLanes}
          {...(band.frameRate !== undefined ? { frameRate: band.frameRate } : {})}
          {...(band.onPlayheadChange !== undefined ? { onPlayheadChange: band.onPlayheadChange } : {})}
          {...(band.onSelectionChange !== undefined ? { onSelectionChange: band.onSelectionChange } : {})}
          disabled={pending}
        />
      ) : null}

      {error !== null ? (
        <p data-testid="timeline-error" role="alert" className={`text-xs ${ui['notice']}`}>
          {error.kind === 'conflict' ? '编辑冲突（服务端状态已变化）：请刷新后重试。' : '操作失败：'}
          {error.message}
          {error.code !== null ? `（${error.code}）` : ''}
        </p>
      ) : null}

      <ol className="flex flex-col gap-2">
        {scenes.map((scene, index) => {
          const definition = getComponent(scene.sceneType, scene.componentVersion ?? undefined);
          const isMedia = MEDIA_TYPES.has(scene.sceneType);
          const props = scene.props as Record<string, unknown>;
          return (
            <li key={scene.id} data-testid={`timeline-row-${String(index)}`} className={`p-2 text-xs ${ui['inset']}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className={`w-8 ${ui['mutedText']}`}>#{scene.position}</span>
                <span className="min-w-32 font-medium">
                  {scene.sceneType}
                  {scene.locked ? <span className={`ml-1 text-xs ${ui['emphasis']}`}>已锁定</span> : null}
                </span>

                <label className="flex items-center gap-1">
                  时长
                  <input
                    aria-label={`时长 ${String(index)}`}
                    type="number"
                    min={500}
                    step={100}
                    defaultValue={scene.durationMs}
                    disabled={pending}
                    onBlur={(event) => {
                      const next = Number(event.target.value);
                      if (Number.isFinite(next) && next !== scene.durationMs && next >= 500) {
                        updateScene(scene.id, { durationMs: next }, scene.revision);
                      }
                    }}
                    className={`w-24 ${ui['field']}`}
                  />
                  ms
                </label>

                <button type="button" aria-label={`上移场景 ${String(index + 1)}`} disabled={pending || index === 0} onClick={() => move(scene.id, -1)} className={ui['button']}>
                  ↑
                </button>
                <button
                  type="button"
                  disabled={pending || index === scenes.length - 1}
                  onClick={() => move(scene.id, 1)}
                  aria-label={`下移场景 ${String(index + 1)}`}
                  className={ui['button']}
                >
                  ↓
                </button>

                <label className="flex items-center gap-1">
                  拆分
                  <input
                    aria-label={`拆分位置 ${String(index)}`}
                    type="number"
                    min={1}
                    placeholder="at ms"
                    value={splitAt[scene.id] ?? ''}
                    disabled={pending}
                    onChange={(event) => setSplitAt((current) => ({ ...current, [scene.id]: event.target.value }))}
                    className={`w-20 ${ui['field']}`}
                  />
                  <button
                    type="button"
                    disabled={pending || (splitAt[scene.id] ?? '') === ''}
                    onClick={() => {
                      const atMs = Number(splitAt[scene.id]);
                      if (Number.isFinite(atMs) && atMs > 0) {
                        onEdit({ operations: [{ op: 'split_scene', sceneId: scene.id, atMs }], expectedSceneRevisions: expected(scene.id) });
                      }
                    }}
                    className={ui['button']}
                  >
                    拆分
                  </button>
                </label>

                <button
                  type="button"
                  disabled={pending}
                  onClick={() => onEdit({ operations: [{ op: 'duplicate_scene', sceneId: scene.id, afterSceneId: null }], expectedSceneRevisions: {} })}
                  className={ui['button']}
                >
                  复制
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => onEdit({ operations: [{ op: 'delete_scene', sceneId: scene.id }], expectedSceneRevisions: expected(scene.id) })}
                  className={ui['dangerButton']}
                >
                  删除
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => onEdit({ operations: [{ op: 'set_scene_lock', sceneId: scene.id, locked: !scene.locked }], expectedSceneRevisions: {} })}
                  className={ui['button']}
                >
                  {scene.locked ? '解锁' : '锁定'}
                </button>

                <label className="flex items-center gap-1">
                  转场
                  <input
                    aria-label={`转场 ${String(index)}`}
                    placeholder="in/out 例如 fade"
                    defaultValue={`${String((scene.transition as { in?: string | null }).in ?? '')}/${String((scene.transition as { out?: string | null }).out ?? '')}`}
                    disabled={pending}
                    onBlur={(event) => {
                      const [inKind, outKind] = event.target.value.split('/');
                      updateScene(scene.id, { transition: { in: inKind === '' || inKind === undefined ? null : inKind, out: outKind === '' || outKind === undefined ? null : outKind } }, scene.revision);
                    }}
                    className={`w-28 ${ui['field']}`}
                  />
                </label>

                {isMedia && definition !== null ? (
                  <>
                    <label className="flex items-center gap-1">
                      缩放
                      <input
                        aria-label={`缩放 ${String(index)}`}
                        type="number"
                        min={0.1}
                        max={4}
                        step={0.1}
                        defaultValue={typeof props['scale'] === 'number' ? (props['scale'] as number) : 1}
                        disabled={pending}
                        onBlur={(event) => {
                          const next = Number(event.target.value);
                          const merged = { ...props, scale: next };
                          if (definition.inputSchema.safeParse(merged).success && next !== props['scale']) {
                            updateScene(scene.id, { props: merged }, scene.revision);
                          }
                        }}
                        className={`w-16 ${ui['field']}`}
                      />
                    </label>
                    <label className="flex items-center gap-1">
                      水平 %
                      <input
                        aria-label={`水平偏移 ${String(index)}`}
                        type="number"
                        min={-100}
                        max={100}
                        step={5}
                        defaultValue={typeof props['offsetX'] === 'number' ? (props['offsetX'] as number) : 0}
                        disabled={pending}
                        onBlur={(event) => {
                          const next = Number(event.target.value);
                          const merged = { ...props, offsetX: next };
                          if (definition.inputSchema.safeParse(merged).success && next !== props['offsetX']) {
                            updateScene(scene.id, { props: merged }, scene.revision);
                          }
                        }}
                        className={`w-16 ${ui['field']}`}
                      />
                    </label>
                    <label className="flex items-center gap-1">
                      替换素材
                      <select
                        aria-label={`替换素材 ${String(index)}`}
                        defaultValue=""
                        disabled={pending || assets.length === 0}
                        onChange={(event) => {
                          if (event.target.value !== '') {
                            onEdit({
                              operations: [{ op: 'replace_asset', sceneId: scene.id, role: 'visual', newAssetId: event.target.value }],
                              expectedSceneRevisions: expected(scene.id),
                            });
                          }
                        }}
                        className={ui['field']}
                      >
                        <option value="">{assets.length === 0 ? '无可用资产' : '选择…'}</option>
                        {assets.map((asset) => (
                          <option key={asset.id} value={asset.id}>
                            {asset.assetType} · {asset.id.slice(0, 10)}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>

      <section data-testid="timeline-audio" className="flex flex-col gap-1 text-xs">
        <h3 className={`font-semibold ${ui['primaryText']}`}>音轨（音量）</h3>
        {graph.audioTracks.length === 0 ? (
          <p className={ui['mutedText']}>暂无音轨：Master Narration 在 P06-03（音频对齐）产生后在此调整音量/淡入淡出。</p>
        ) : (
          graph.audioTracks.map((track) => (
            <label key={track.id} className="flex items-center gap-2">
              {track.kind}
              <input
                aria-label={`音量 ${track.id}`}
                type="number"
                min={0}
                max={2}
                step={0.05}
                defaultValue={track.volume}
                disabled={pending}
                onBlur={(event) => {
                  const next = Number(event.target.value);
                  if (Number.isFinite(next) && next !== track.volume) {
                    onEdit({ operations: [{ op: 'update_audio_track', trackId: track.id, changes: { volume: next } }], expectedSceneRevisions: {} });
                  }
                }}
                className={`w-20 ${ui['field']}`}
              />
            </label>
          ))
        )}
      </section>

      <section data-testid="timeline-captions" className="flex flex-col gap-1 text-xs">
        <h3 className={`font-semibold ${ui['primaryText']}`}>字幕修正</h3>
        {graph.captions.length === 0 ? (
          <p className={ui['mutedText']}>暂无字幕：全局对齐（P06-03）产生字幕后在此修正文本。</p>
        ) : (
          graph.captions.map((caption) => (
            <label key={caption.id} className="flex items-center gap-2">
              <span className={`w-20 ${ui['mutedText']}`}>{caption.startMs}ms</span>
              <input
                aria-label={`字幕文本 ${caption.id}`}
                defaultValue={caption.text}
                disabled={pending}
                onBlur={(event) => {
                  if (event.target.value !== caption.text) {
                    onEdit({ operations: [{ op: 'update_caption', captionId: caption.id, changes: { text: event.target.value } }], expectedSceneRevisions: {} });
                  }
                }}
                className={`flex-1 ${ui['field']}`}
              />
            </label>
          ))
        )}
      </section>
    </div>
  );
}
