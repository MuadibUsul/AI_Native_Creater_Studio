/**
 * 自主制作（V6-9，裁决 0020 / Proposal 0.1 AP-05）的界面文案：交给 AI 剪完的设置、进度卡与交付报告。
 * 中文为基准，英文覆盖同一结构——类型检查保证不缺键。带参数的文案写成函数；金额、秒数由调用方先格式化。
 */

type Tier = 'ASK_EACH' | 'AUTO_SAFE';
type RunStatus = 'WAITING_FOR_FOOTAGE' | 'DIRECTING' | 'CHECKING' | 'DELIVERED' | 'NEEDS_REVIEW' | 'FAILED' | 'CANCELLED';
type NotAdopted = 'APPROVAL_ASK_EACH' | 'REVIEW_GATE' | 'AUTHORIZATION_CHANGED' | 'PROJECT_CHANGED' | 'NO_CHANGES' | 'TURN_FAILED';
type Unmet = 'TARGET_DURATION' | 'NO_FOOTAGE_USED' | 'BUDGET_REACHED' | 'ITERATION_LIMIT' | 'UNPRICED_MODEL';
type FailReason = 'FOOTAGE_TIMEOUT' | 'NO_FOOTAGE' | 'SESSION_BUSY' | 'NOT_SIGNED' | 'BUDGET_EXHAUSTED' | 'MODEL' | 'GENERIC';
type StartError = 'NOT_SIGNED' | 'BUDGET_EXHAUSTED' | 'RUN_IN_PROGRESS' | 'GENERIC';

const zhCN = {
  setup: {
    toggle: '交给 AI 自己剪完',
    toggleHint: '交代一次需求：AI 等素材处理好，定计划、粗剪、自检修复，再按你选的方式交付。之后仍可在共看片室里一起精修。',
    goalLabel: '你想要一条什么样的视频',
    goalPlaceholder: '例如：3 分钟的冰岛自驾 vlog，节奏轻快，开头就要抓人',
    goalRequired: '请写一句你想要的效果',
    durationLabel: '目标时长',
    durationAuto: 'AI 按素材定',
    duration: (seconds: number) => (seconds < 60 ? `${String(seconds)} 秒` : `${String(seconds / 60)} 分钟`),
    approvalLabel: '剪完以后',
    approvals: {
      ASK_EACH: { title: '先给我看', hint: '做成试改，你看过再决定用不用' },
      AUTO_SAFE: { title: '自检通过就直接用', hint: '自检没有警告就采用为当前版本，随时可以撤销' },
    } satisfies Record<Tier, { title: string; hint: string }>,
    budgetLabel: 'AI 费用上限（美元）',
    budgetHint: '导演模型的费用到上限就停，不会超出。这一版不调用付费生成。',
    budgetInvalid: (min: string, max: string) => `请填写 ${min} 到 ${max} 之间的金额`,
    signed: (tier: string, budget: string, version: number) => `当前授权：${tier} · 上限 ${budget}（第 ${String(version)} 版）`,
    revoke: '撤回授权',
    revoking: '正在撤回…',
    start: '交给 AI',
    starting: '正在交代…',
    startErrors: {
      NOT_SIGNED: '授权没有签上，请再试一次。',
      BUDGET_EXHAUSTED: '这份授权的费用已经用完，请提高上限再开始。',
      RUN_IN_PROGRESS: 'AI 已经在剪这条视频了。',
      GENERIC: '没能交给 AI，请再试一次。',
    } satisfies Record<StartError, string>,
    created: '作品已经建好，但没能交给 AI。',
    openAnyway: '先进入共看片室',
    dialogTitle: '交给 AI 剪完',
    open: '交给 AI 剪完…',
    close: '关闭',
  },
  card: {
    label: 'AI 自己剪',
    status: {
      WAITING_FOR_FOOTAGE: '等素材准备好',
      DIRECTING: '正在剪',
      CHECKING: '正在自检',
      DELIVERED: '剪好了',
      NEEDS_REVIEW: '剪好了，等你看',
      FAILED: '没能剪完',
      CANCELLED: '已停下',
    } satisfies Record<RunStatus, string>,
    waitingBody: '放入素材，处理好就开始。',
    steps: (count: number) => `已做 ${String(count)} 步`,
    goal: (goal: string) => `你的要求：${goal}`,
    stop: '停下',
    stopping: '正在停下…',
    stopFailed: '没能停下，请再试一次。',
    outcome: {
      ADOPTED: '已采用为当前版本，可以撤销。',
      TRIAL: '保留为试改：在对话里"就这样"采用，或"撤回"。',
      NO_CHANGES: 'AI 没有做改动。',
      FAILED: '没能完成。',
    },
    notAdopted: {
      APPROVAL_ASK_EACH: '你选了"先给我看"。',
      REVIEW_GATE: '自检发现了要你看一眼的问题，所以没有直接采用。',
      AUTHORIZATION_CHANGED: '运行中授权被改动或撤回，所以没有直接采用。',
      PROJECT_CHANGED: '运行期间你改过作品，没有覆盖你的改动。',
      NO_CHANGES: '没有改动可采用。',
      TURN_FAILED: 'AI 这一轮没有完成。',
    } satisfies Record<NotAdopted, string>,
    failed: {
      FOOTAGE_TIMEOUT: '素材一直没有处理好。',
      NO_FOOTAGE: '一直没有放入素材。',
      SESSION_BUSY: '对话一直被占用，AI 没能开始。',
      NOT_SIGNED: '开始前授权被撤回了。',
      BUDGET_EXHAUSTED: '授权的费用不够了。',
      MODEL: '导演模型出错了。',
      GENERIC: '运行出错了。',
    } satisfies Record<FailReason, string>,
    reportTitle: '交付报告',
    timeline: (length: string, clips: number, captions: number) => `成片 ${length} 秒 · ${String(clips)} 个片段 · ${String(captions)} 条字幕`,
    originalShare: (percent: number) => `画面里 ${String(percent)}% 来自你的素材`,
    footageUsed: '用到的素材',
    generated: '生成内容',
    generatedKinds: { EFFECT: '特效', NARRATION: '合成讲述', GENERATED_VIDEO: '生成镜头' },
    seconds: (value: string) => `${value} 秒`,
    review: (warnings: number, notes: number) => `自检：${String(warnings)} 个警告，${String(notes)} 条提示`,
    notChecked: (items: string) => `没有检查：${items}`,
    /** 自检发现按种类翻译（工具原文是给导演看的英文）；未知种类显示原文 */
    findingKinds: {
      EMPTY_TIMELINE: '时间线是空的', BLACK_STRETCH: '用到了素材里的黑场', SILENT_STRETCH: '用到了素材里的静音段', FLASH_CLIP: '片段太短，看起来像闪帧',
      PICTURE_GAP: '画面有空档', LENGTH_MISMATCH: '内容与成片长度对不上', CUT_MID_SENTENCE: '剪点切断了一句话', MISSING_SOUND: '有声素材下面没有声音', REPEATED_SHOT: '重复用了同一段素材',
    } as Record<string, string>,
    /** 没做的检查（按工具原文里的关键词翻译）；未知的显示原文 */
    notCheckedItems: [
      ['black frames', '黑场（素材还没分析）'], ['spoken sentences', '句中剪断（没有转写）'], ['silent stretches', '静音段（素材还没分析）'], ['review_draft unavailable', '自检工具不可用'],
    ] as [string, string][],
    pace: (cuts: string, words: string | null) => `节奏：每分钟 ${cuts} 刀${words === null ? '' : ` · 每秒 ${words} 字`}`,
    paceDeviations: (count: number) => `${String(count)} 处偏离目标节奏`,
    plan: (version: number, logline: string, scenes: number) => `制作计划第 ${String(version)} 版：${logline}（${String(scenes)} 场）`,
    unmetTitle: '要留意',
    unmet: {
      TARGET_DURATION: (detail: string) => {
        const [target, actual] = detail.split('/');
        return `时长：目标 ${target ?? '?'} 秒，实际 ${actual ?? '?'} 秒`;
      },
      NO_FOOTAGE_USED: () => '成片里没有用到你的素材',
      BUDGET_REACHED: () => '费用到了上限，AI 提前停下',
      ITERATION_LIMIT: () => '步骤用完，AI 提前停下',
      UNPRICED_MODEL: () => '导演模型没有价格表，花费无法核算',
    } satisfies Record<Unmet, (detail: string) => string>,
    cost: (spent: string, budget: string | null) => (budget === null ? `花费 ${spent}` : `花费 ${spent} / 上限 ${budget}`),
    unpriced: (count: number) => `另有 ${String(count)} 次调用未定价`,
    note: 'AI 的说明',
  },
};

const en: typeof zhCN = {
  setup: {
    toggle: 'Let AI finish the edit',
    toggleHint: 'Brief it once: AI waits for the footage, plans, rough-cuts, checks and fixes its work, then delivers the way you choose. You can still refine it together in the studio.',
    goalLabel: 'What video do you want',
    goalPlaceholder: 'e.g. A 3-minute Iceland road-trip vlog, upbeat, with a hook in the first seconds',
    goalRequired: 'Describe what you want in a sentence',
    durationLabel: 'Target length',
    durationAuto: 'AI decides from the footage',
    duration: (seconds: number) => (seconds < 60 ? `${String(seconds)} s` : `${String(seconds / 60)} min`),
    approvalLabel: 'When it is done',
    approvals: {
      ASK_EACH: { title: 'Show me first', hint: 'Kept as a trial edit; you decide whether to use it' },
      AUTO_SAFE: { title: 'Use it if the check passes', hint: 'Adopted as the current version when the self-check has no warnings; you can undo anytime' },
    },
    budgetLabel: 'AI spending cap (USD)',
    budgetHint: 'The director model stops at the cap and never goes over. This version does not use paid generation.',
    budgetInvalid: (min: string, max: string) => `Enter an amount between ${min} and ${max}`,
    signed: (tier: string, budget: string, version: number) => `Current authorization: ${tier} · cap ${budget} (version ${String(version)})`,
    revoke: 'Revoke authorization',
    revoking: 'Revoking…',
    start: 'Hand it to AI',
    starting: 'Briefing…',
    startErrors: {
      NOT_SIGNED: 'The authorization was not recorded. Please try again.',
      BUDGET_EXHAUSTED: 'This authorization has no budget left. Raise the cap to start.',
      RUN_IN_PROGRESS: 'AI is already editing this video.',
      GENERIC: 'Could not hand it to AI. Please try again.',
    },
    created: 'The video was created, but it could not be handed to AI.',
    openAnyway: 'Open the studio anyway',
    dialogTitle: 'Let AI finish the edit',
    open: 'Let AI finish the edit…',
    close: 'Close',
  },
  card: {
    label: 'AI editing on its own',
    status: {
      WAITING_FOR_FOOTAGE: 'Waiting for footage',
      DIRECTING: 'Editing',
      CHECKING: 'Checking its work',
      DELIVERED: 'Done',
      NEEDS_REVIEW: 'Done, waiting for you',
      FAILED: 'Could not finish',
      CANCELLED: 'Stopped',
    },
    waitingBody: 'Add footage; it starts once processing finishes.',
    steps: (count: number) => `${String(count)} step${count === 1 ? '' : 's'} so far`,
    goal: (goal: string) => `Your brief: ${goal}`,
    stop: 'Stop',
    stopping: 'Stopping…',
    stopFailed: 'Could not stop. Please try again.',
    outcome: {
      ADOPTED: 'Adopted as the current version. You can undo it.',
      TRIAL: 'Kept as a trial edit: keep it or discard it in the conversation.',
      NO_CHANGES: 'AI made no changes.',
      FAILED: 'Did not finish.',
    },
    notAdopted: {
      APPROVAL_ASK_EACH: 'You chose "Show me first".',
      REVIEW_GATE: 'The self-check found something for you to look at, so it was not adopted.',
      AUTHORIZATION_CHANGED: 'The authorization changed or was revoked during the run, so it was not adopted.',
      PROJECT_CHANGED: 'You edited the video during the run; your changes were not overwritten.',
      NO_CHANGES: 'There was nothing to adopt.',
      TURN_FAILED: 'The AI turn did not complete.',
    },
    failed: {
      FOOTAGE_TIMEOUT: 'The footage never finished processing.',
      NO_FOOTAGE: 'No footage was added.',
      SESSION_BUSY: 'The conversation stayed busy, so AI could not start.',
      NOT_SIGNED: 'The authorization was revoked before editing started.',
      BUDGET_EXHAUSTED: 'Not enough authorized budget was left.',
      MODEL: 'The director model failed.',
      GENERIC: 'The run failed.',
    },
    reportTitle: 'Delivery report',
    timeline: (length: string, clips: number, captions: number) => `${length} s · ${String(clips)} clip${clips === 1 ? '' : 's'} · ${String(captions)} caption${captions === 1 ? '' : 's'}`,
    originalShare: (percent: number) => `${String(percent)}% of the picture is your footage`,
    footageUsed: 'Footage used',
    generated: 'Generated content',
    generatedKinds: { EFFECT: 'Effect', NARRATION: 'Synthetic narration', GENERATED_VIDEO: 'Generated shot' },
    seconds: (value: string) => `${value} s`,
    review: (warnings: number, notes: number) => `Self-check: ${String(warnings)} warning${warnings === 1 ? '' : 's'}, ${String(notes)} note${notes === 1 ? '' : 's'}`,
    notChecked: (items: string) => `Not checked: ${items}`,
    findingKinds: {
      EMPTY_TIMELINE: 'The timeline is empty', BLACK_STRETCH: 'Black picture from the footage is used', SILENT_STRETCH: 'Near-silence from the footage is used', FLASH_CLIP: 'A clip is so short it reads as a flash frame',
      PICTURE_GAP: 'There is a gap with no picture', LENGTH_MISMATCH: 'The content and the video length do not match', CUT_MID_SENTENCE: 'A cut lands inside a spoken sentence', MISSING_SOUND: 'Footage with sound plays with nothing audible', REPEATED_SHOT: 'The same part of the footage is used twice',
    },
    notCheckedItems: [
      ['black frames', 'black frames (footage not analyzed)'], ['spoken sentences', 'cuts inside sentences (no transcript)'], ['silent stretches', 'silent stretches (footage not analyzed)'], ['review_draft unavailable', 'the self-check tool was unavailable'],
    ],
    pace: (cuts: string, words: string | null) => `Pace: ${cuts} cuts per minute${words === null ? '' : ` · ${words} words per second`}`,
    paceDeviations: (count: number) => `${String(count)} stretch${count === 1 ? '' : 'es'} off the target pace`,
    plan: (version: number, logline: string, scenes: number) => `Production plan v${String(version)}: ${logline} (${String(scenes)} scene${scenes === 1 ? '' : 's'})`,
    unmetTitle: 'Worth a look',
    unmet: {
      TARGET_DURATION: (detail: string) => {
        const [target, actual] = detail.split('/');
        return `Length: target ${target ?? '?'} s, actual ${actual ?? '?'} s`;
      },
      NO_FOOTAGE_USED: () => 'None of your footage is in the cut',
      BUDGET_REACHED: () => 'Spending reached the cap, so AI stopped early',
      ITERATION_LIMIT: () => 'AI ran out of steps and stopped early',
      UNPRICED_MODEL: () => 'The director model has no price table, so spending cannot be counted',
    },
    cost: (spent: string, budget: string | null) => (budget === null ? `Spent ${spent}` : `Spent ${spent} of ${budget}`),
    unpriced: (count: number) => `${String(count)} unpriced call${count === 1 ? '' : 's'}`,
    note: 'AI notes',
  },
};

export const AUTONOMY_TEXT = { 'zh-CN': zhCN, en };
