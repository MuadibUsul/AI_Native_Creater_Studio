// 脚本导演（SCRIPTED，不是真实 Provider）：读本轮上下文（素材、时间线、指点、请求），只用统一工具目录里的
// edit_timeline / review_draft / add_effect / update_effect；审片讨论只回方案，审片执行按批注指着的片段修改；
// 请求里提到特效（爆炸、光效……）时用模板加在指着的画面区域，提到颜色时改已有特效的颜色。
// 选了风格时（上下文里的 optional_style_strategy 只是数据）：第一版按风格测得的镜头中位时长切镜头，并在回复里说明。
// 有文章、时间线为空时（V6-5）：逐段讲述（add_narration）→ 每段配一张图解卡，时间对齐该段讲述（标题卡 / 大数字 / 要点）→ 自检 → 回复。
// 测试替身直接用文章段落当讲述稿；真实导演会改写成口语讲述稿。
// 请求里要求付费生成时（V6-7/V6-8）：先 list_generation_options，再 quote_generation（只报价），回复里说清价格、等你确认——
// 框了画面区域说"重绘/换成" → 选区重绘；说"数字人/我出镜" → 用已授权的身份档案出镜（引号里的话就是讲稿）；说"生成一个镜头" → 生成镜头。
// 交给 AI 剪完（V6-9，上下文里有 autonomous_production）：写制作计划 → 每条素材取 3 秒拼成第一版 → 自检与节奏 → 交付说明。
// 分章（V6-10，交代里有 phase）：定计划时每条素材一章；剪一章时放这一章场景的素材；通看收尾时自检后交付。
// 验收可以让某几章故意失败（failChapters，按章名）、让每章慢一点（chapterDelayMs），用来看逐章进度与只重做一章。
// 用于在没有模型密钥时验证界面、服务端与评测框架的闭环；真实剪辑与特效质量要用真实模型评测。
import { randomUUID } from 'node:crypto';
import { AgentModelFailure } from '../../packages/contracts/dist/index.js';

const tag = (text, name) => {
  const match = text.match(new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`));
  return match === null ? null : match[1];
};
const usage = { inputTokens: 1200, outputTokens: 180, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
const EFFECT_WORDS = [
  [/爆炸|explo|boom/i, 'burst'], [/漏光|light leak/i, 'light-leak'], [/光效|光晕|glow/i, 'glow'], [/闪光|sparkle/i, 'sparkles'],
  [/冲击波|shock/i, 'shockwave'], [/彩纸|confetti/i, 'confetti'],
];
const GENERATION_WORDS = [
  [/数字人|我出镜|digital human|my avatar/i, 'AVATAR_CLIP'], [/重绘|换成|regenerate|replace .* with/i, 'VIDEO_REGION'], [/生成.{0,6}镜头|generate (a|one) shot|b-?roll/i, 'VIDEO_SHOT'],
];
const COLOR_WORDS = [[/红|red/i, '#ff3b30'], [/蓝|blue/i, '#3aa0ff'], [/金|gold/i, '#ffd25a'], [/绿|green/i, '#34c759']];

export class ScriptedDirector {
  providerId = 'scripted';
  implementation = 'SCRIPTED';
  model = 'scripted-director';
  calls = 0;

  /** @param {{ failChapters?: string[]; chapterDelayMs?: number }} [options] */
  constructor(options = {}) {
    /** 这些章名的章剪不成（验收用；清空后重做就能剪成） */
    this.failChapters = new Set(options.failChapters ?? []);
    this.chapterDelayMs = options.chapterDelayMs ?? 0;
  }

  async respond(request) {
    this.calls += 1;
    const first = request.messages[0];
    const text = first.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
    const session = JSON.parse(tag(text, 'session') ?? '{}');
    const zh = session.language !== 'en';
    const article = JSON.parse(tag(text, 'article') ?? 'null');
    const startTimeline = JSON.parse(tag(text, 'timeline') ?? '{}');
    if (article !== null && (startTimeline.clips ?? []).length === 0) return this.#articleStep(request, article, zh);
    const autonomous = JSON.parse(tag(text, 'autonomous_production') ?? 'null');
    if (autonomous !== null && typeof autonomous.phase === 'string') return this.#chapterStep(request, text, zh, autonomous);
    if (autonomous !== null) return this.#autonomousStep(request, text, zh, autonomous);
    const last = request.messages.at(-1);
    const results = last.content.filter((block) => block.type === 'tool_result');
    if (results.length > 0) {
      const lastCall = request.messages.at(-2)?.content.find((block) => block.type === 'tool_use')?.name;
      if (lastCall === 'list_generation_options' || lastCall === 'quote_generation') return this.#generationStep(request, text, zh, lastCall, results[0]);
      const failed = results.find((block) => block.isError);
      if (failed !== undefined) {
        if (failed.content.includes('PRODUCTION_POLICY_BLOCKED')) {
          return this.#reply(zh ? '这个作品还没开启特效：点输入框上方的"特效：关"打开后再说一次。' : 'Effects are off for this project. Turn them on with "Effects: off" above the message box, then ask again.');
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
    // "换成蓝色"：已有特效时是改特效颜色，不是付费重绘（"换成"也是重绘的触发词，先判断改色）
    if (GENERATION_WORDS.some(([pattern]) => pattern.test(requestText)) && !(effectClip !== undefined && color !== undefined)) {
      return { model: this.model, content: [{ type: 'tool_use', id: `tu_${randomUUID()}`, name: 'list_generation_options', input: {} }], stopReason: 'tool_use', usage };
    }
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
    const styleMedian = Number((tag(text, 'optional_style_strategy') ?? '').match(/\(median ([0-9.]+) s\)/)?.[1] ?? NaN);
    if (videoClips.length === 0 && Number.isFinite(styleMedian) && styleMedian > 0 && styleMedian < 3) {
      // 风格参考：每条素材取 3 秒，按测得的中位镜头时长切开、素材之间交替
      const shot = Math.max(0.2, Math.round(styleMedian * 10) / 10);
      const perItem = Math.min(8, Math.floor(3 / shot));
      operations = [];
      for (let index = 0; index < perItem; index += 1) {
        for (const item of items) {
          const start = 0.5 + index * shot;
          operations.push({ op: 'place_clip', footageId: item.footageId, sourceStart: start.toFixed(1), sourceEnd: (start + shot).toFixed(1) });
        }
      }
      operations.push({ op: 'fit_length' });
      this.pendingReply = zh
        ? `按参考风格剪了第一版：镜头中位 ${String(styleMedian)} 秒，所以每个镜头 ${String(shot)} 秒、素材交替，共 ${String(operations.length - 1)} 个镜头。`
        : `First cut in the reference style: median shot ${String(styleMedian)} s, so ${String(shot)} s shots alternating between clips, ${String(operations.length - 1)} shots in total.`;
    } else if (videoClips.length === 0) {
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

  /** 付费生成：看可用选项 → 报价（只报价，用户在界面上确认）→ 回复价格。 */
  #generationStep(request, text, zh, lastCall, result) {
    const requestText = tag(text, 'request') ?? '';
    const pointer = JSON.parse(tag(text, 'pointer') ?? '{}');
    const body = JSON.parse(result.content);
    if (lastCall === 'quote_generation') {
      if (result.isError) {
        const reason = String(body.reason ?? '');
        if (reason === 'PRODUCTION_POLICY_BLOCKED') return this.#reply(zh ? '这个作品还没允许付费生成：点输入框上方的"生成：关"打开后再说一次。' : 'Paid generation is off for this project. Turn it on with "Generation: off" above the message box, then ask again.');
        if (reason.includes('CONSENT') || reason.includes('REFERENCE')) return this.#reply(zh ? '你的形象或声音还没准备好：先在"我的形象与声音"里上传照片和声音样本并授权。' : 'Your likeness or voice is not ready yet: add a photo and a voice sample and give consent on "My likeness & voice".');
        return this.#reply((zh ? '这次没法报价：' : "Couldn't quote: ") + String(body.error ?? '').slice(0, 160));
      }
      return this.#reply(zh ? `报好价了：约 ${String(body.seconds)} 秒，预计 ${String(body.estimate)}。在下面的报价卡上确认后才会生成。` : `Quoted: about ${String(body.seconds)} s, estimated ${String(body.estimate)}. Nothing is generated until you confirm the quote card below.`);
    }
    const kind = GENERATION_WORDS.find(([pattern]) => pattern.test(requestText))?.[1] ?? 'VIDEO_SHOT';
    const offer = (body.offers ?? []).find((item) => item.kind === kind);
    if (offer === undefined || offer.available !== true) return this.#reply(zh ? '这个部署还没有接入这类生成的供应商。' : 'This deployment has no provider for that kind of generation yet.');
    const quoted = requestText.match(/[「“"]([^」”"]{1,400})[」”"]/)?.[1];
    let input;
    if (kind === 'AVATAR_CLIP') {
      const identity = (body.identities ?? []).find((item) => item.likeness === 'READY' && item.voice === 'READY') ?? (body.identities ?? [])[0];
      if (identity === undefined) return this.#reply(zh ? '还没有身份档案：先在"我的形象与声音"里建一个。' : 'There is no identity yet: create one on "My likeness & voice".');
      const script = quoted ?? requestText;
      const corner = /角落|[右左][下上]角|画中画|corner|picture-in-picture/i.test(requestText);
      input = { kind, identityId: identity.id, script, language: /[\u4e00-\u9fff]/.test(script) ? 'zh' : 'en', framing: corner ? 'CORNER' : 'FULL',
        summary: zh ? `${identity.name}${corner ? '在右下角' : ''}出镜说：${script.slice(0, 40)}` : `${identity.name} on camera${corner ? ' (corner)' : ''}: ${script.slice(0, 40)}` };
    } else if (kind === 'VIDEO_REGION') {
      const what = quoted ?? requestText;
      input = { kind, prompt: what, summary: zh ? `把框出的区域重绘成：${what.slice(0, 40)}` : `Regenerate the framed area as: ${what.slice(0, 40)}` };
      if (pointer.timeRange === undefined || pointer.timeRange === null) {
        const clip = (pointer.clips ?? [])[0];
        if (clip !== undefined) Object.assign(input, { start: clip.at[0], end: String(Math.min(Number(clip.at[1]), Number(clip.at[0]) + offer.maxSeconds)) });
      }
    } else {
      const what = quoted ?? requestText;
      input = { kind, prompt: what, seconds: '3', summary: zh ? `生成一个 3 秒镜头：${what.slice(0, 40)}` : `A 3-second generated shot: ${what.slice(0, 40)}` };
    }
    return { model: this.model, content: [{ type: 'tool_use', id: `tu_${randomUUID()}`, name: 'quote_generation', input }], stopReason: 'tool_use', usage };
  }

  /** 交给 AI 剪完：按已经做过的工具调用推进（计划 → 第一版 → 自检 + 节奏 → 交付说明）。 */
  #autonomousStep(request, text, zh, autonomous) {
    const calls = request.messages.flatMap((message) => message.content.filter((block) => block.type === 'tool_use'));
    const done = new Set(calls.map((call) => call.name));
    const footage = JSON.parse(tag(text, 'footage') ?? '[]');
    const items = (Array.isArray(footage) ? footage : footage.footage ?? []).filter((item) => item.kind === 'video').sort((a, b) => a.name.localeCompare(b.name));
    const tool = (...uses) => ({ model: this.model, content: uses.map(([name, input]) => ({ type: 'tool_use', id: `tu_${randomUUID()}`, name, input })), stopReason: 'tool_use', usage });
    if (items.length === 0) return this.#reply(zh ? '工程里没有可用的视频素材，这次没有剪。' : 'There is no usable video footage in the project, so nothing was cut.');
    const goal = String(autonomous.goal ?? '').split('\n')[0].slice(0, 120) || (zh ? '一条视频' : 'A video');
    if (!done.has('plan_production')) {
      return tool(['plan_production', {
        blueprint: {
          logline: goal, structure: items.map((item) => item.name).join(' → '),
          targetDurationSeconds: autonomous.targetDurationSeconds ?? null, paceTarget: { cutsPerMinute: 20, wordsPerSecond: null },
        },
        scenes: items.map((item, index) => ({
          id: `scene_${String(index + 1)}`, title: item.name.slice(0, 80), goal: index === 0 ? (zh ? '开场：先给最好看的画面' : 'Opening: lead with the strongest picture') : (zh ? '推进' : 'Move the story on'),
          sources: [{ footageId: item.footageId, from: '0.5', to: '3.5' }],
          intents: [{ id: `intent_${String(index + 1)}`, type: index === 0 ? 'HOOK' : 'RHYTHM', targetFeeling: zh ? '一眼想看下去' : 'Want to keep watching', reason: zh ? '测试替身按素材顺序各取 3 秒' : 'The test double takes 3 seconds of each clip in order' }],
        })),
      }]);
    }
    if (!done.has('edit_timeline')) {
      return tool(['edit_timeline', { operations: [...items.map((item) => ({ op: 'place_clip', footageId: item.footageId, sourceStart: '0.5', sourceEnd: '3.5' })), { op: 'fit_length' }] }]);
    }
    if (!done.has('review_draft')) return tool(['review_draft', {}], ['measure_pace', {}]);
    return this.#reply(zh
      ? `剪好了第一版：${items.map((item) => item.name).join(' → ')}，各取 3 秒，共 ${String(items.length * 3)} 秒。这是测试替身，按素材顺序拼接，没有判断内容。`
      : `First cut done: ${items.map((item) => item.name).join(' → ')}, 3 seconds each, ${String(items.length * 3)} seconds in total. This is a test double that joins the footage in order without judging the content.`);
  }

  /** V6-10 分章的三个阶段：定计划（每条素材一章）→ 剪一章 → 通看收尾 */
  async #chapterStep(request, text, zh, autonomous) {
    const done = new Set(request.messages.flatMap((message) => message.content.filter((block) => block.type === 'tool_use').map((block) => block.name)));
    const tool = (...uses) => ({ model: this.model, content: uses.map(([name, input]) => ({ type: 'tool_use', id: `tu_${randomUUID()}`, name, input })), stopReason: 'tool_use', usage });
    if (autonomous.phase === 'PLAN_CHAPTERS') {
      if (done.has('plan_production')) return this.#reply(zh ? '按素材分章，每条素材一章。' : 'One chapter per clip.');
      const footage = JSON.parse(tag(text, 'footage') ?? '[]');
      const items = (Array.isArray(footage) ? footage : footage.footage ?? []).filter((item) => item.kind === 'video').sort((a, b) => a.name.localeCompare(b.name));
      const goal = String(autonomous.goal ?? '').split('\n')[0].slice(0, 120) || (zh ? '一条视频' : 'A video');
      return tool(['plan_production', {
        blueprint: { logline: goal, structure: items.map((item) => item.name).join(' → '), targetDurationSeconds: autonomous.targetDurationSeconds ?? null },
        scenes: items.map((item, index) => ({
          id: `scene_${String(index + 1)}`, title: item.name.slice(0, 80), goal: zh ? '这一段' : 'This part',
          window: { start: String(index * 3), end: String(index * 3 + 3) }, sources: [{ footageId: item.footageId, from: '0.5', to: '3.5' }],
        })),
      }]);
    }
    if (autonomous.phase === 'CUT_CHAPTER') {
      const chapter = autonomous.chapter ?? {};
      if (this.chapterDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.chapterDelayMs));
      if (this.failChapters.has(chapter.title)) throw new AgentModelFailure('BAD_REQUEST', 'the director model returned an error for this chapter (scripted test failure)');
      if (!done.has('edit_timeline')) {
        const source = chapter.scene?.sources?.[0];
        if (source === undefined) return this.#reply(zh ? '这一章没有素材。' : 'This chapter has no footage.');
        return tool(['edit_timeline', { operations: [{ op: 'place_clip', footageId: source.footageId, sourceStart: source.from, sourceEnd: source.to }, { op: 'fit_length' }] }]);
      }
      return this.#reply(zh ? `第 ${String(chapter.number)} 章剪好了。` : `Chapter ${String(chapter.number)} is cut.`);
    }
    if (!done.has('review_draft')) return tool(['review_draft', {}]);
    const missing = (autonomous.chapters ?? []).filter((chapter) => chapter.status !== 'SUCCEEDED').map((chapter) => chapter.title);
    if (autonomous.redo === true) return this.#reply(zh ? '重做的这一章放回了原来的位置，接缝看过了。' : 'The redone chapter is back in its place; the joins look fine.');
    return this.#reply(missing.length === 0
      ? (zh ? '各章拼好了，接缝看过了。' : 'The chapters are joined and the seams checked.')
      : (zh ? `其余各章拼好了；没剪成：${missing.join('、')}。` : `The other chapters are joined; not cut: ${missing.join(', ')}.`));
  }

  /** 文章第一版：按已经做过的工具调用推进（讲述 → 图解卡 → 自检 → 回复）。 */
  #articleStep(request, article, zh) {
    const calls = [];
    const results = new Map();
    for (const message of request.messages) {
      for (const block of message.content) {
        if (block.type === 'tool_use') calls.push(block);
        if (block.type === 'tool_result') results.set(block.toolUseId, block);
      }
    }
    const last = calls.at(-1);
    const lastResult = last === undefined ? undefined : results.get(last.id);
    if (lastResult?.isError === true && last.name === 'add_narration') {
      const reason = JSON.parse(lastResult.content).reason ?? '';
      return this.#reply(reason === 'NARRATION_LANGUAGE_UNSUPPORTED'
        ? (zh ? '现在配置的声音不会说这篇文章的语言，需要先配置相应语言的配音。' : 'No configured voice speaks the language of this article; a voice for it has to be configured first.')
        : (zh ? `没能配上讲述：${reason}` : `Could not add the narration: ${reason}`));
    }
    const paragraphs = article.paragraphs.map((paragraph) => paragraph.text);
    const narrated = calls.filter((call) => call.name === 'add_narration').map((call) => JSON.parse(results.get(call.id)?.content ?? '{}'));
    const tool = (name, input) => ({ model: this.model, content: [{ type: 'tool_use', id: `tu_${randomUUID()}`, name, input }], stopReason: 'tool_use', usage });
    if (narrated.length < paragraphs.length) return tool('add_narration', { text: paragraphs[narrated.length] });
    const cards = calls.filter((call) => call.name === 'add_effect');
    if (cards.length < paragraphs.length) {
      const index = cards.length;
      const part = narrated[index];
      const seconds = Math.min(30, Number(part.at[1]) - Number(part.at[0])).toFixed(3);
      const paragraph = paragraphs[index];
      const sentences = paragraph.split(/(?<=[.!?])\s+|(?<=[。！？])/).map((item) => item.trim()).filter(Boolean);
      const number = paragraph.match(/\d[\d,]*(?:\.\d+)?(?:\s?(?:%|percent))?/);
      if (index === 0) {
        return tool('add_effect', { template: 'title-card', at: part.at[0], seconds, params: { title: article.title || sentences[0].slice(0, 80), subtitle: (sentences[0] ?? '').slice(0, 140) } });
      }
      if (number !== null) {
        const value = number[0].replace(/\s?percent$/, '%');
        return tool('add_effect', { template: 'big-number', at: part.at[0], seconds, params: { value, label: (sentences.find((item) => item.includes(number[0])) ?? sentences[0]).slice(0, 120) } });
      }
      return tool('add_effect', { template: 'key-points', at: part.at[0], seconds, params: { heading: sentences[0].split(/\s+/).slice(0, 4).join(' ').slice(0, 80), points: sentences.slice(0, 5).map((item) => item.slice(0, 60)).join('|') } });
    }
    if (!calls.some((call) => call.name === 'review_draft')) return tool('review_draft', {});
    const total = narrated.at(-1)?.at?.[1] ?? '0';
    return this.#reply(zh
      ? `第一版：${String(paragraphs.length)} 段讲述（共 ${Number(total).toFixed(1)} 秒），每段配了一张图解卡。`
      : `First version: ${String(paragraphs.length)} narrated parts (${Number(total).toFixed(1)} s in total), each with a diagram card.`);
  }

  #reply(text) {
    return { model: this.model, content: [{ type: 'text', text }], stopReason: 'end_turn', usage };
  }
}
