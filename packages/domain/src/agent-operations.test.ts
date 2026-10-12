import { describe, expect, it } from 'vitest';
import { ApiFailure, legacyMillisecondsToMediaTime, type MediaRange } from '@ancs/contracts';
import type { KernelClip, KernelTrack, TimelineState } from '@ancs/kernel';
import { agentSecondsToTime, sequenceContentEnd, translateAgentEdit, type AgentEditContext } from './agent-operations.js';
import { AGENT_SYSTEM_PROMPT, compileAgentContext } from './agent-prompt.js';
import { defaultAgentToolCatalog } from './agent-tools.js';

/** V6-1a：Agent 编辑词汇 → 内核操作的精确翻译；导演提示与工具目录保持通用（不含类型专用规则）。 */

const MS = { num: 1, den: 1000 };
const mt = (milliseconds: number) => legacyMillisecondsToMediaTime(milliseconds);
const range = (start: number, end: number): MediaRange => ({ start: mt(start), end: mt(end) });
const track = (id: string, kind: string, position: number): KernelTrack => ({ id, sequenceId: 'seq', kind, position, name: id, locked: false, muted: false, hidden: false, solo: false, syncLocked: false });
const clip = (id: string, trackId: string, sequence: MediaRange, source: MediaRange = sequence): KernelClip => ({
  id, sequenceId: 'seq', trackId, assetVersionId: 'av', nestedSequenceId: null, sourceStreamId: null, sourceRange: source, sequenceRange: sequence,
  timeMapping: { kind: 'LINEAR', rate: { num: 1, den: 1 }, direction: 'FORWARD', preservePitch: true }, avGroupId: null, parentClipId: null, parameters: null,
});

function context(partial: Partial<TimelineState> = {}): AgentEditContext {
  let n = 0;
  return {
    sequenceId: 'seq',
    timebase: MS,
    locale: 'zh-CN',
    newId: (prefix) => `${prefix}_${String((n += 1))}`,
    state: {
      sequences: new Map([['seq', { id: 'seq', duration: mt(10_000) }]]),
      tracks: [], clips: [], audioRegions: [], captions: [], locks: new Map(),
      sources: { assetVersions: new Map() }, policy: { preserveOriginalSpeech: false },
      ...partial,
    },
  };
}

describe('Agent 秒 → 序列时间', () => {
  it('十进制文本精确换算并吸附到序列时基；数字在边界处按 6 位小数转换；非法值 422', () => {
    expect(agentSecondsToTime('1.5', MS)).toEqual(mt(1500));
    expect(agentSecondsToTime('0.0334', MS)).toEqual(mt(33)); // 就近吸附到 1ms
    expect(agentSecondsToTime(2.25, MS)).toEqual(mt(2250));
    expect(agentSecondsToTime('1', { num: 1, den: 30 })).toEqual({ ticks: '30', timebase: { num: 1, den: 30 } });
    for (const bad of ['-1', '1e3', 'abc']) {
      expect(() => agentSecondsToTime(bad, MS)).toThrow(ApiFailure);
    }
  });
});

describe('translateAgentEdit', () => {
  it('place_clip：没有视频轨就先建一条；超出成片长度先延长到刚好容纳；预分配 id', () => {
    const ops = translateAgentEdit({ op: 'place_clip', footageId: 'av_1', sourceStart: '0', sourceEnd: '12' }, context());
    expect(ops.map((op) => op.op)).toEqual(['create_track', 'set_sequence_duration', 'insert_clip']);
    expect(ops[0]).toMatchObject({ track: { kind: 'VIDEO', position: 0 }, restoreTrackId: 'trk_1' });
    expect(ops[1]).toMatchObject({ duration: mt(12_000) });
    expect(ops[2]).toMatchObject({ trackId: 'trk_1', mode: 'APPEND', sequenceStart: null, sourceRange: range(0, 12_000), createdClipId: 'clp_2', createdAudioClipId: 'clp_3', linkAudio: true });
  });

  it('place_clip 指定时间：默认覆盖、可选插入（按全序列内容终点估算所需长度）；不超长不延长', () => {
    const state = { tracks: [track('v1', 'VIDEO', 0)], clips: [clip('k1', 'v1', range(0, 4000))] };
    const overwrite = translateAgentEdit({ op: 'place_clip', footageId: 'av', sourceStart: '0', sourceEnd: '2', at: '1' }, context(state));
    expect(overwrite.map((op) => op.op)).toEqual(['insert_clip']);
    expect(overwrite[0]).toMatchObject({ mode: 'OVERWRITE', sequenceStart: mt(1000), trackId: 'v1' });
    const insert = translateAgentEdit({ op: 'place_clip', footageId: 'av', sourceStart: '0', sourceEnd: '7', at: '1', mode: 'insert' }, context(state));
    expect(insert.map((op) => op.op)).toEqual(['set_sequence_duration', 'insert_clip']);
    expect(insert[0]).toMatchObject({ duration: mt(11_000) });
  });

  it('trim_clip：默认涟漪（收头/收尾两步）；关闭涟漪时同时收源范围与序列范围', () => {
    const state = { tracks: [track('v1', 'VIDEO', 0)], clips: [clip('k1', 'v1', range(1000, 5000), range(2000, 6000))] };
    expect(translateAgentEdit({ op: 'trim_clip', clipId: 'k1', trimHead: '0.5', trimTail: '1' }, context(state))).toEqual([
      { op: 'ripple_clip', clipId: 'k1', action: 'TRIM_HEAD', amount: mt(500), closeAcrossTracks: false },
      { op: 'ripple_clip', clipId: 'k1', action: 'TRIM_TAIL', amount: mt(1000), closeAcrossTracks: false },
    ]);
    expect(translateAgentEdit({ op: 'trim_clip', clipId: 'k1', trimHead: '0.5', closeGap: false }, context(state))).toEqual([
      { op: 'trim_clip', clipId: 'k1', sourceRange: { start: mt(2500), end: mt(6000) }, sequenceRange: { start: mt(1500), end: mt(5000) } },
    ]);
    expect(() => translateAgentEdit({ op: 'trim_clip', clipId: 'k1' }, context(state))).toThrow(ApiFailure);
    expect(() => translateAgentEdit({ op: 'trim_clip', clipId: 'missing', trimHead: '1' }, context(state))).toThrow(ApiFailure);
  });

  it('remove / move / caption / fit_length', () => {
    const state = { tracks: [track('v1', 'VIDEO', 0)], clips: [clip('k1', 'v1', range(0, 3000))] };
    expect(translateAgentEdit({ op: 'remove_clip', clipId: 'k1' }, context(state))).toEqual([{ op: 'ripple_clip', clipId: 'k1', action: 'DELETE', amount: null, closeAcrossTracks: true }]);
    expect(translateAgentEdit({ op: 'remove_clip', clipId: 'k1', closeGap: false }, context(state))).toEqual([{ op: 'delete_clip', clipId: 'k1' }]);
    const move = translateAgentEdit({ op: 'move_clip', clipId: 'k1', to: '9' }, context(state));
    expect(move.map((op) => op.op)).toEqual(['set_sequence_duration', 'move_clip']);
    expect(move[1]).toMatchObject({ sequenceRange: range(9000, 12_000) });
    const caption = translateAgentEdit({ op: 'add_caption', text: 'Hello', start: '1', end: '2.5', language: 'en' }, context(state));
    expect(caption.map((op) => op.op)).toEqual(['create_track', 'create_caption']);
    expect(caption[1]).toMatchObject({ trackId: 'trk_1', sequenceRange: range(1000, 2500), localRange: range(0, 1500), languageTag: 'en', restoreCaptionId: 'cap_2' });
    expect(translateAgentEdit({ op: 'fit_length' }, context(state))).toEqual([{ op: 'set_sequence_duration', sequenceId: 'seq', duration: mt(3000) }]);
    expect(() => translateAgentEdit({ op: 'fit_length' }, context())).toThrow(ApiFailure);
    expect(sequenceContentEnd(context(state).state, 'seq', MS)).toEqual(mt(3000));
  });
});

describe('通用性守卫（裁决 0018）', () => {
  // 导演提示与工具说明不得写入某一视频类型或某一风格的专用规则
  const GENRE_TERMS = /vlog|travel|tutorial|explainer|mr\.?\s?beast|旅游|旅行|解说|知识|娱乐|小林/i;

  it('系统提示与工具说明不含类型/风格专用词；工具目录稳定有序', () => {
    expect(AGENT_SYSTEM_PROMPT).not.toMatch(GENRE_TERMS);
    const catalog = defaultAgentToolCatalog();
    const descriptors = catalog.descriptors();
    for (const tool of descriptors) expect(`${tool.name} ${tool.description}`).not.toMatch(GENRE_TERMS);
    expect(JSON.stringify(defaultAgentToolCatalog().descriptors())).toBe(JSON.stringify(descriptors));
  });

  it('策略只作为可选数据块进入上下文；未选用时没有策略块', () => {
    const base = { locale: 'en', project: { title: 't', mode: 'FOOTAGE_EDIT' }, timeline: {}, footage: {}, pointer: {}, recentTurns: [], request: 'cut it' };
    expect(compileAgentContext({ ...base, strategy: null })).not.toContain('optional_style_strategy');
    expect(compileAgentContext({ ...base, strategy: { id: 'pack_1', guidance: 'fast cuts' } })).toContain('<optional_style_strategy>\nid: pack_1\nfast cuts');
  });
});
