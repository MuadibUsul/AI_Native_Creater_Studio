import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ApiFailure,
  ERROR_CODES,
  addMediaTime,
  compareMediaTime,
  isDecimalSecondsText,
  mediaRangeDuration,
  mediaTimeSchema,
  parseDecimalSeconds,
  rescaleMediaTime,
  subtractMediaTime,
  visualCropSchema,
  visualTransformSchema,
  type EditOperation,
  type MediaRange,
  type MediaTime,
  type Rational,
} from '@ancs/contracts';
import type { KernelClip, TimelineState } from '@ancs/kernel';

/**
 * 通用导演 Agent 的编辑词汇（V6 §6.3）：模型用"秒"描述意图，这里**精确**翻译成编辑内核操作。
 *
 * - 时间：十进制秒文本（或数字，在边界处转成最多 6 位小数）→ 有理时间 → 吸附到序列编辑时基（就近）；
 *   源范围与序列范围用同一网格，保证 1:1 映射的时长严格相等。
 * - 新对象 id 在翻译时预先分配（createdClipId / restoreTrackId / restoreCaptionId），草稿重放与采用后 id 不变，
 *   模型在后续调用里可以稳定地引用它刚放上去的片段。
 * - 便利语义（只为减少模型的样板步骤，不替模型做剪辑决定）：放片段时没有视频轨就建一条，
 *   超出当前成片长度就把长度延长到刚好容纳；`fit_length` 把成片长度收到内容终点。
 * 这里没有任何按视频类型或策略分支的逻辑（裁决 0018）。
 */

const DECIMAL_HINT = 'Seconds as a decimal string, e.g. "12.5" (max 6 decimals).';
const secondsSchema = z.union([z.string().max(20), z.number().nonnegative().max(1e9)]).describe(DECIMAL_HINT);
const idSchema = z.string().min(1).max(200);

export const agentEditOperationSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('place_clip').describe('Place a piece of footage on the timeline.'),
    footageId: idSchema.describe('Footage id from list_footage.'),
    sourceStart: secondsSchema.describe('Start inside the footage (seconds).'),
    sourceEnd: secondsSchema.describe('End inside the footage (seconds, exclusive).'),
    at: secondsSchema.optional().describe('Timeline position. Omit to append after the last clip on the track.'),
    mode: z.enum(['overwrite', 'insert']).optional().describe('overwrite (default) replaces what is under the range; insert pushes later clips right.'),
    trackId: idSchema.optional().describe('Video track id; defaults to the first video track (created if none).'),
    withAudio: z.boolean().optional().describe('Bring the footage audio along as a linked audio clip (default true when the footage has audio).'),
  }).strict(),
  z.object({
    op: z.literal('remove_clip').describe('Remove a clip.'),
    clipId: idSchema,
    closeGap: z.boolean().optional().describe('Ripple-delete: shift later material left on all tracks (default true).'),
  }).strict(),
  z.object({
    op: z.literal('split_clip').describe('Split a clip at a timeline time.'),
    clipId: idSchema,
    at: secondsSchema,
  }).strict(),
  z.object({
    op: z.literal('trim_clip').describe('Shorten a clip from its head and/or tail.'),
    clipId: idSchema,
    trimHead: secondsSchema.optional().describe('Seconds to remove from the start.'),
    trimTail: secondsSchema.optional().describe('Seconds to remove from the end.'),
    closeGap: z.boolean().optional().describe('Ripple: shift later material to close the gap (default true). Linked audio is trimmed with the clip and all tracks shift together to stay in sync; otherwise only the same track shifts.'),
  }).strict(),
  z.object({
    op: z.literal('move_clip').describe('Move a clip to a new timeline start (duration unchanged).'),
    clipId: idSchema,
    to: secondsSchema,
    trackId: idSchema.optional().describe('Destination track of the same kind.'),
  }).strict(),
  z.object({ op: z.literal('set_opacity'), clipId: idSchema, opacity: z.number().min(0).max(1) }).strict(),
  z.object({ op: z.literal('set_transform'), clipId: idSchema, transform: visualTransformSchema }).strict(),
  z.object({ op: z.literal('set_crop'), clipId: idSchema, crop: visualCropSchema }).strict(),
  z.object({
    op: z.literal('add_caption').describe('Add an on-screen caption/text line.'),
    text: z.string().min(1).max(500),
    start: secondsSchema,
    end: secondsSchema,
    language: z.string().min(2).max(35).optional().describe('BCP-47 tag, defaults to the session language.'),
    trackId: idSchema.optional().describe('Caption track id; defaults to the first caption track (created if none).'),
  }).strict(),
  z.object({ op: z.literal('remove_caption'), captionId: idSchema }).strict(),
  z.object({
    op: z.literal('set_track'),
    trackId: idSchema,
    muted: z.boolean().optional(),
    hidden: z.boolean().optional(),
    name: z.string().min(1).max(200).optional(),
  }).strict(),
  z.object({
    op: z.literal('add_track'),
    kind: z.enum(['VIDEO', 'AUDIO', 'GRAPHIC', 'CAPTION']),
    name: z.string().min(1).max(200).optional(),
  }).strict(),
  z.object({ op: z.literal('set_length').describe('Set the total video length.'), seconds: secondsSchema }).strict(),
  z.object({ op: z.literal('fit_length').describe('Set the total length to where the last content ends.') }).strict(),
]);
export type AgentEditOperation = z.infer<typeof agentEditOperationSchema>;

export interface AgentEditContext {
  sequenceId: string;
  /** 序列编辑时基（序列时长的时基）：所有时间吸附到这里 */
  timebase: Rational;
  state: TimelineState;
  locale: string;
  newId?: (prefix: 'clp' | 'trk' | 'cap') => string;
}

const fail = (message: string, details: Record<string, unknown> = {}): never => {
  throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, message, 422, { reason: 'AGENT_EDIT_INVALID', ...details });
};

/** 模型给出的秒 → 序列时基上的 MediaTime（就近吸附）。数字在边界处按 6 位小数转文本。 */
export function agentSecondsToTime(value: string | number, timebase: Rational): MediaTime {
  const text = typeof value === 'number' ? trimDecimal(value.toFixed(6)) : value.trim();
  if (!isDecimalSecondsText(text)) fail(`invalid seconds value ${JSON.stringify(value)}`, { value: String(value) });
  return rescaleMediaTime(parseDecimalSeconds(text), timebase, 'nearest');
}

function trimDecimal(text: string): string {
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

const zeroAt = (timebase: Rational): MediaTime => mediaTimeSchema.parse({ ticks: '0', timebase });
const maxTime = (left: MediaTime, right: MediaTime): MediaTime => (compareMediaTime(left, right) >= 0 ? left : right);

function sequenceDuration(context: AgentEditContext): MediaTime {
  const sequence = context.state.sequences.get(context.sequenceId);
  if (sequence === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'sequence not found', 404);
  return sequence.duration;
}

/** 序列内容终点（片段/字幕/音频区域的最大终点；空序列为 0）。 */
export function sequenceContentEnd(state: TimelineState, sequenceId: string, timebase: Rational): MediaTime {
  let end = zeroAt(timebase);
  for (const clip of state.clips) if (clip.sequenceId === sequenceId) end = maxTime(end, clip.sequenceRange.end);
  for (const caption of state.captions) if (caption.sequenceId === sequenceId) end = maxTime(end, caption.sequenceRange.end);
  for (const region of state.audioRegions) if (region.sequenceId === sequenceId) end = maxTime(end, region.sequenceRange.end);
  return end;
}

function findClip(context: AgentEditContext, clipId: string): KernelClip {
  const clip = context.state.clips.find((item) => item.id === clipId && item.sequenceId === context.sequenceId);
  return clip ?? fail(`clip ${clipId} is not on this timeline`, { clipId });
}

function firstTrackOfKind(context: AgentEditContext, kind: string): string | null {
  const tracks = context.state.tracks.filter((track) => track.sequenceId === context.sequenceId && track.kind === kind)
    .sort((left, right) => left.position - right.position);
  return tracks[0]?.id ?? null;
}

function nextTrackPosition(context: AgentEditContext): number {
  return context.state.tracks.filter((track) => track.sequenceId === context.sequenceId).length;
}

/**
 * 翻译一条 Agent 编辑操作为内核操作序列（可能含便利性的前置操作）。
 * 只做形状与时间换算；业务规则（重叠、锁、源边界……）由内核在试改中判定，错误原样回给模型。
 */
export function translateAgentEdit(operation: AgentEditOperation, context: AgentEditContext): EditOperation[] {
  const newId = context.newId ?? ((prefix: 'clp' | 'trk' | 'cap') => `${prefix}_${randomUUID()}`);
  const timebase = context.timebase;
  const at = (value: string | number): MediaTime => agentSecondsToTime(value, timebase);
  // 加减结果回到序列时基（操作数都在该时基上，结果精确可表示），保持写入的时间规范
  const inBase = (time: MediaTime): MediaTime => rescaleMediaTime(time, timebase, 'nearest');
  const range = (start: MediaTime, end: MediaTime): MediaRange => {
    if (compareMediaTime(end, start) <= 0) fail('range end must be after start');
    return { start, end };
  };
  const extendTo = (required: MediaTime): EditOperation[] =>
    (compareMediaTime(required, sequenceDuration(context)) > 0 ? [{ op: 'set_sequence_duration', sequenceId: context.sequenceId, duration: required }] : []);

  switch (operation.op) {
    case 'place_clip': {
      const prefix: EditOperation[] = [];
      let trackId = operation.trackId ?? firstTrackOfKind(context, 'VIDEO');
      if (trackId === null) {
        trackId = newId('trk');
        prefix.push({ op: 'create_track', sequenceId: context.sequenceId, track: { kind: 'VIDEO', position: nextTrackPosition(context), name: 'V1' }, restoreTrackId: trackId });
      }
      const sourceRange = range(at(operation.sourceStart), at(operation.sourceEnd));
      const duration = mediaRangeDuration(sourceRange);
      const mode = operation.at === undefined ? 'APPEND' : operation.mode === 'insert' ? 'INSERT' : 'OVERWRITE';
      const sequenceStart = operation.at === undefined ? null : at(operation.at);
      // 需要的成片长度：APPEND 接在该轨末尾；INSERT 会把后面的内容整体后推（按全序列内容终点估上界）
      const trackEnd = context.state.clips.filter((clip) => clip.trackId === trackId)
        .reduce((end, clip) => maxTime(end, clip.sequenceRange.end), zeroAt(timebase));
      const required = mode === 'APPEND'
        ? addMediaTime(trackEnd, duration)
        : mode === 'INSERT'
          ? addMediaTime(maxTime(sequenceContentEnd(context.state, context.sequenceId, timebase), sequenceStart ?? zeroAt(timebase)), duration)
          : addMediaTime(sequenceStart ?? zeroAt(timebase), duration);
      return [
        ...prefix,
        ...extendTo(inBase(required)),
        {
          op: 'insert_clip',
          sequenceId: context.sequenceId,
          trackId,
          assetVersionId: operation.footageId,
          nestedSequenceId: null,
          sourceStreamId: null,
          sourceRange,
          mode,
          sequenceStart,
          linkAudio: operation.withAudio ?? true,
          audioTrackId: null,
          createdClipId: newId('clp'),
          createdAudioClipId: newId('clp'),
        },
      ];
    }
    case 'remove_clip':
      findClip(context, operation.clipId);
      return [operation.closeGap === false
        ? { op: 'delete_clip', clipId: operation.clipId }
        : { op: 'ripple_clip', clipId: operation.clipId, action: 'DELETE', amount: null, closeAcrossTracks: true }];
    case 'split_clip':
      findClip(context, operation.clipId);
      return [{ op: 'split_clip', clipId: operation.clipId, at: at(operation.at), createdClipId: newId('clp'), createdAudioClipId: newId('clp') }];
    case 'trim_clip': {
      const clip = findClip(context, operation.clipId);
      const head = operation.trimHead === undefined ? zeroAt(timebase) : at(operation.trimHead);
      const tail = operation.trimTail === undefined ? zeroAt(timebase) : at(operation.trimTail);
      const zero = zeroAt(timebase);
      if (compareMediaTime(head, zero) === 0 && compareMediaTime(tail, zero) === 0) fail('trim_clip needs trimHead or trimTail');
      if (operation.closeGap !== false) {
        // 带关联声音的片段：收缝覆盖全部轨道，画面与声音一起缩短、保持同步（与 remove_clip 的默认一致）
        const closeAcrossTracks = clip.avGroupId !== null;
        const out: EditOperation[] = [];
        if (compareMediaTime(head, zero) > 0) out.push({ op: 'ripple_clip', clipId: clip.id, action: 'TRIM_HEAD', amount: head, closeAcrossTracks });
        if (compareMediaTime(tail, zero) > 0) out.push({ op: 'ripple_clip', clipId: clip.id, action: 'TRIM_TAIL', amount: tail, closeAcrossTracks });
        return out;
      }
      const sequenceRange = range(inBase(addMediaTime(clip.sequenceRange.start, head)), inBase(subtractMediaTime(clip.sequenceRange.end, tail)));
      const sourceRange = range(inBase(addMediaTime(clip.sourceRange.start, head)), inBase(subtractMediaTime(clip.sourceRange.end, tail)));
      return [{ op: 'trim_clip', clipId: clip.id, sourceRange, sequenceRange }];
    }
    case 'move_clip': {
      const clip = findClip(context, operation.clipId);
      const start = at(operation.to);
      const end = inBase(addMediaTime(start, mediaRangeDuration(clip.sequenceRange)));
      return [
        ...extendTo(end),
        { op: 'move_clip', clipId: clip.id, sequenceRange: { start, end }, ...(operation.trackId === undefined ? {} : { trackId: operation.trackId }) },
      ];
    }
    case 'set_opacity':
      return [{ op: 'set_clip_opacity', clipId: findClip(context, operation.clipId).id, opacity: operation.opacity }];
    case 'set_transform':
      return [{ op: 'set_clip_transform', clipId: findClip(context, operation.clipId).id, transform: operation.transform }];
    case 'set_crop':
      return [{ op: 'set_clip_crop', clipId: findClip(context, operation.clipId).id, crop: operation.crop }];
    case 'add_caption': {
      const prefix: EditOperation[] = [];
      let trackId = operation.trackId ?? firstTrackOfKind(context, 'CAPTION');
      if (trackId === null) {
        trackId = newId('trk');
        prefix.push({ op: 'create_track', sequenceId: context.sequenceId, track: { kind: 'CAPTION', position: nextTrackPosition(context), name: 'C1' }, restoreTrackId: trackId });
      }
      const sequenceRange = range(at(operation.start), at(operation.end));
      return [
        ...prefix,
        ...extendTo(sequenceRange.end),
        {
          op: 'create_caption',
          sequenceId: context.sequenceId,
          trackId,
          timeBinding: { basis: 'SEQUENCE', clipId: null, semanticCueId: null },
          localRange: { start: zeroAt(timebase), end: inBase(mediaRangeDuration(sequenceRange)) },
          sequenceRange,
          text: operation.text,
          languageTag: operation.language ?? context.locale,
          style: { schemaVersion: '1.0', values: {} },
          words: [],
          speechAnchorId: null,
          restoreCaptionId: newId('cap'),
        },
      ];
    }
    case 'remove_caption':
      return [{ op: 'delete_caption', captionId: operation.captionId }];
    case 'set_track': {
      const changes = {
        ...(operation.muted === undefined ? {} : { muted: operation.muted }),
        ...(operation.hidden === undefined ? {} : { hidden: operation.hidden }),
        ...(operation.name === undefined ? {} : { name: operation.name }),
      };
      if (Object.keys(changes).length === 0) fail('set_track needs at least one change');
      return [{ op: 'update_track', trackId: operation.trackId, changes }];
    }
    case 'add_track': {
      const position = nextTrackPosition(context);
      const name = operation.name ?? `${operation.kind[0] ?? 'T'}${String(context.state.tracks.filter((track) => track.sequenceId === context.sequenceId && track.kind === operation.kind).length + 1)}`;
      return [{ op: 'create_track', sequenceId: context.sequenceId, track: { kind: operation.kind, position, name }, restoreTrackId: newId('trk') }];
    }
    case 'set_length':
      return [{ op: 'set_sequence_duration', sequenceId: context.sequenceId, duration: at(operation.seconds) }];
    case 'fit_length': {
      const end = sequenceContentEnd(context.state, context.sequenceId, timebase);
      if (compareMediaTime(end, zeroAt(timebase)) <= 0) fail('the timeline is empty; nothing to fit');
      return [{ op: 'set_sequence_duration', sequenceId: context.sequenceId, duration: end }];
    }
  }
}
