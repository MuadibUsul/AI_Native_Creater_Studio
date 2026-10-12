// 脚本导演（SCRIPTED，不是真实 Provider）：读本轮上下文（素材、时间线、指点、请求），只用统一工具目录里的
// edit_timeline 与 review_draft。用于在没有模型密钥时验证界面、服务端与评测框架的闭环；真实剪辑质量要用真实模型评测。
import { randomUUID } from 'node:crypto';

const tag = (text, name) => {
  const match = text.match(new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`));
  return match === null ? null : match[1];
};
const usage = { inputTokens: 1200, outputTokens: 180, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };

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
      if (failed !== undefined) return this.#reply((zh ? '这次改不了：' : "Couldn't apply: ") + failed.content.slice(0, 160));
      // 编辑之后先自检一次（和真实导演一样走通用自检），再回应
      const reviewed = request.messages.some((message) => message.content.some((block) => block.type === 'tool_use' && block.name === 'review_draft'));
      if (!reviewed) return { model: this.model, content: [{ type: 'tool_use', id: `tu_${randomUUID()}`, name: 'review_draft', input: {} }], stopReason: 'tool_use', usage };
      return this.#reply(this.pendingReply ?? (zh ? '好了。' : 'Done.'));
    }
    const footage = JSON.parse(tag(text, 'footage') ?? '[]');
    const timeline = JSON.parse(tag(text, 'timeline') ?? '{}');
    const pointer = JSON.parse(tag(text, 'pointer') ?? '{}');
    const items = (Array.isArray(footage) ? footage : footage.footage ?? []).filter((item) => item.kind === 'video').sort((a, b) => a.name.localeCompare(b.name));
    const videoTracks = new Set((timeline.tracks ?? []).filter((track) => track.kind === 'VIDEO').map((track) => track.id));
    const videoClips = (timeline.clips ?? []).filter((clip) => videoTracks.has(clip.track));
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
