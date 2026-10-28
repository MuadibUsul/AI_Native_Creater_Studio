/**
 * 剪辑师在场（体验：和一位专业剪辑师一起工作，而不是操作工具）：AI 正在做的事来自这一轮真实的工具记录
 * （每做一步服务端就追加一条），这里只把工具名翻成"在做什么"和"在画布哪一块做"，不编造进度。
 * 画布上的剪辑师光标移到对应的画框，对话里显示"第 N 步 · 在做什么"。
 */

export type PresenceTarget = 'monitor' | 'footage' | 'plan' | 'article';
export type PresenceActivity = 'thinking' | 'watching' | 'footage' | 'editPoints' | 'planning' | 'cutting' | 'captions' | 'checking' | 'pace' | 'effects' | 'narration' | 'reading' | 'quoting';

const TOOL_PRESENCE: Record<string, [PresenceActivity, PresenceTarget]> = {
  get_timeline: ['watching', 'monitor'],
  look_at_timeline: ['watching', 'monitor'],
  list_footage: ['footage', 'footage'],
  inspect_footage: ['footage', 'footage'],
  look_at_footage: ['footage', 'footage'],
  search_footage: ['footage', 'footage'],
  find_edit_points: ['editPoints', 'footage'],
  plan_production: ['planning', 'plan'],
  get_production_plan: ['planning', 'plan'],
  edit_timeline: ['cutting', 'monitor'],
  caption_speech: ['captions', 'monitor'],
  review_draft: ['checking', 'monitor'],
  measure_pace: ['pace', 'monitor'],
  list_effects: ['effects', 'monitor'],
  add_effect: ['effects', 'monitor'],
  update_effect: ['effects', 'monitor'],
  list_voices: ['narration', 'monitor'],
  add_narration: ['narration', 'monitor'],
  remove_narration: ['narration', 'monitor'],
  read_article: ['reading', 'article'],
  list_generation_options: ['quoting', 'monitor'],
  quote_generation: ['quoting', 'monitor'],
};

/** 最近一步的工具 → 在做什么、在哪一块；还没调用工具时是"在想"。不认识的工具（新注册的组件）算在成片上做事。 */
export function presenceOf(lastTool: string | null): { activity: PresenceActivity; target: PresenceTarget } {
  if (lastTool === null) return { activity: 'thinking', target: 'monitor' };
  const known = TOOL_PRESENCE[lastTool];
  return known === undefined ? { activity: 'cutting', target: 'monitor' } : { activity: known[0], target: known[1] };
}

/** 素材时长（十进制秒文本）合计，四舍五入到整秒；没有可用时长时为 null */
export function totalFootageSeconds(durations: readonly (string | null)[]): number | null {
  const values = durations.filter((value): value is string => value !== null).map(Number).filter((value) => Number.isFinite(value) && value > 0);
  return values.length === 0 ? null : Math.round(values.reduce((sum, value) => sum + value, 0));
}
