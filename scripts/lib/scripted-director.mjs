// 脚本导演（SCRIPTED，不是真实 Provider）：读本轮上下文（素材、时间线、指点、请求），只用统一工具目录里的
// edit_timeline / review_draft / add_effect / update_effect；审片讨论只回方案，审片执行按批注指着的片段修改；
// 请求里提到特效（爆炸、光效……）时用模板加在指着的画面区域，提到颜色时改已有特效的颜色。
// 用于在没有模型密钥时验证界面、服务端与评测框架的闭环；真实剪辑与特效质量要用真实模型评测。
import { randomUUID } from 'node:crypto';

const tag = (text, name) => {
  const match = text.match(new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`));
  return match === null ? null : match[1];
};
const usage = { inputTokens: 1200, outputTokens: 180, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
const EFFECT_WORDS = [
  [/爆炸|explo|boom/i, 'burst'], [/漏光|light leak/i, 'light-leak'], [/光效|光晕|glow/i, 'glow'], [/闪光|sparkle/i, 'sparkles'],
  [/冲击波|shock/i, 'shockwave'], [/彩纸|confetti/i, 'confetti'],
];
const COLOR_WORDS = [[/红|red/i, '#ff3b30'], [/蓝|blue/i, '#3aa0ff'], [/金|gold/i, '#ffd25a'], [/绿|green/i, '#34c759']];

export class ScriptedDirector {
  providerId = 'scripted';
  implementation = 'SCRIPTED';
  model = 'scripted-director';
  calls = 0;

  async respond(request) {
    this.calls += 1;
    const first = request.messages[0];
    const text = first.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
    const session = JSON.parse(tag(text, 'session') ?? '{}');
    const zh = session.language !== 'en';
    const last = request.messages.at(-1);
    const results = last.content.filter((block) => block.type === 'tool_result');
    if (results.length > 0) {
      const failed = results.find((block) => block.isError);
      if (failed !== undefined) {
        if (failed.content.includes('PRODUCTION_POLICY_BLOCKED')) {
          return this.#reply(zh ? '这个作品还没开启特效：点顶栏的"特效：关"打开后再说一次。' : 'Effects are off for this project. Turn them on with "Effects: off" in the top bar, then ask again.');
        }
        return this.#reply((zh ? '这次改不了：' : "Couldn't apply: ") + failed.content.slice(0, 160));
      }
      // 编辑之后先自检一次（和真实导演一样走通用自检），再回应
      const reviewed = request.messages.some((message) => message.content.some((block) => block.type === 'tool_use' && block.name === 'review_draft'));
      if (!reviewed) return { model: this.model, content: [{ type: 'tool_use', id: `tu_${randomUUID()}`, name: 'review_draft', input: {} }], stopReason: 'tool_use', usage };
      return this.#reply(this.pendingReply ?? (zh ? '好了。' : 'Done.'));
    }
    const footage = JSON.parse(tag(text, 'footage') ?? '[]');
    const timeline = JSON.parse(tag(text, 'timeline') ?? '{}');
    const pointer = JSON.parse(tag(text, 'pointer') ?? '{}');
    const review = JSON.parse(tag(text, 'review') ?? 'null');
    if (review?.mode === 'DISCUSS_NOTE') {
      // 讨论批注：只给方案，不改时间线
      return this.#reply(zh ? '把这一段剪短 1 秒，后面的内容跟着前移。' : 'Trim this part by 1 second and move everything after it up.');
    }
    if (review?.mode === 'APPLY_REVIEW') {
      // 一次执行：每条批注找到它指着的画面片段，各剪短 1 秒
      const videoTrackIds = new Set((timeline.tracks ?? []).filter((track) => track.kind === 'VIDEO').map((track) => track.id));
      const clips = (timeline.clips ?? []).filter((clip) => videoTrackIds.has(clip.track));
      const targets = new Set();
      for (const note of review.notes ?? []) {
        const middle = note.at === null ? NaN : (Number(note.at.start) + Number(note.at.end)) / 2;
        const clip = clips.find((candidate) => (note.clips ?? []).includes(candidate.id))
          ?? clips.find((candidate) => Number(candidate.at[0]) <= middle && middle < Number(candidate.at[1]));
        if (clip !== undefined) targets.add(clip.id);
      }
      if (targets.size === 0) return this.#reply(zh ? '没找到批注指着的片段，没有改动。' : 'I could not find the parts the notes point at, so nothing changed.');
      this.pendingReply = zh ? `按 ${String(review.notes.length)} 条批注改好了：相关片段各剪短 1 秒。` : `Applied ${String(review.notes.length)} notes: each part was trimmed by 1 second.`;
      const operations = [...[...targets].map((clipId) => ({ op: 'trim_clip', clipId, trimTail: '1' })), { op: 'fit_length' }];
      return { model: this.model, content: [{ type: 'tool_use', id: `tu_${randomUUID()}`, name: 'edit_timeline', input: { operations } }], stopReason: 'tool_use', usage };
    }
    const requestText = tag(text, 'request') ?? '';
    const effectClip = (timeline.clips ?? []).find((clip) => typeof clip.effect === 'string');
    const color = COLOR_WORDS.find(([pattern]) => pattern.test(requestText))?.[1];
    if (effectClip !== undefined && color !== undefined) {
      // 改已有特效的颜色：同一段特效代码按新参数重渲（不写新代码）
      this.pendingReply = zh ? `把「${effectClip.effect}」改成了新的颜色。` : `Changed the color of "${effectClip.effect}".`;
      return { model: this.model, content: [{ type: 'tool_use', id: `tu_${randomUUID()}`, name: 'update_effect', input: { clipId: effectClip.id, params: { color } } }], stopReason: 'tool_use', usage };
    }
    const template = EFFECT_WORDS.find(([pattern]) => pattern.test(requestText))?.[1];
    if (template !== undefined) {
      // 加特效：位置与时间取指着的画面区域与时间（工具缺省值），只给模板与时长
      const where = pointer.frameRegion === undefined ? (zh ? '画面中间' : 'the middle of the picture') : (zh ? '框出的位置' : 'the framed area');
      this.pendingReply = zh ? `在${where}加了一个特效（模板 ${template}）。` : `Added an effect (${template} template) in ${where}.`;
      return { model: this.model, content: [{ type: 'tool_use', id: `tu_${randomUUID()}`, name: 'add_effect', input: { template, ...(color === undefined ? {} : { params: { color } }) } }], stopReason: 'tool_use', usage };
    }
    const items = (Array.isArray(footage) ? footage : footage.footage ?? []).filter((item) => item.kind === 'video').sort((a, b) => a.name.localeCompare(b.name));
    const videoTracks = new Set((timeline.tracks ?? []).filter((track) => track.kind === 'VIDEO').map((track) => track.id));
    const videoClips = (timeline.clips ?? []).filter((clip) => videoTracks.has(clip.track) && clip.effect === undefined);
    let operations;
    if (videoClips.length === 0) {
      operations = [...items.map((item) => ({ op: 'place_clip', footageId: item.footageId, sourceStart: '0.5', sourceEnd: '3.5' })), { op: 'fit_length' }];
      this.pendingReply = zh
        ? `第一版：${items.map((item) => item.name).join(' → ')}，各取 3 秒，共 ${String(items.length * 3)} 秒。`
        : `First cut: ${items.map((item) => item.name).join(' → ')}, 3 seconds each, ${String(items.length * 3)} seconds in total.`;
    } else {
      const start = Number(pointer.timeRange?.start ?? NaN);
      const pointed = (pointer.clips ?? []).map((clip) => clip.id);
      const target = videoClips.find((clip) => pointed.includes(clip.id))
        ?? videoClips.find((clip) => Number(clip.at[0]) <= start && start < Number(clip.at[1]));
      if (target === undefined) return this.#reply(zh ? '请在时间带上指一下要改的那一段。' : 'Point at the part on the timeline you want changed.');
      operations = [{ op: 'trim_clip', clipId: target.id, trimTail: '1' }, { op: 'fit_length' }];
      this.pendingReply = zh ? '把这一段剪短了 1 秒，后面的内容跟着前移。' : 'Trimmed this part by 1 second; everything after it moved up.';
    }
    return { model: this.model, content: [{ type: 'tool_use', id: `tu_${randomUUID()}`, name: 'edit_timeline', input: { operations } }], stopReason: 'tool_use', usage };
  }

  #reply(text) {
    return { model: this.model, content: [{ type: 'text', text }], stopReason: 'end_turn', usage };
  }
}
