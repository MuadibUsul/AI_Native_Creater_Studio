import { describe, expect, it } from 'vitest';
import { presenceOf, totalFootageSeconds } from './editor-presence';

/** 剪辑师在场：最近一步的工具 → 在做什么、在画布哪一块（只翻译真实工具记录，不编造进度）。 */
describe('剪辑师在场', () => {
  it('工具 → 活动与画框；还没调用工具是"在想"；新注册的组件算在成片上做事', () => {
    expect(presenceOf(null)).toEqual({ activity: 'thinking', target: 'monitor' });
    expect(presenceOf('look_at_footage')).toEqual({ activity: 'footage', target: 'footage' });
    expect(presenceOf('find_edit_points')).toEqual({ activity: 'editPoints', target: 'footage' });
    expect(presenceOf('plan_production')).toEqual({ activity: 'planning', target: 'plan' });
    expect(presenceOf('edit_timeline')).toEqual({ activity: 'cutting', target: 'monitor' });
    expect(presenceOf('review_draft')).toEqual({ activity: 'checking', target: 'monitor' });
    expect(presenceOf('read_article')).toEqual({ activity: 'reading', target: 'article' });
    expect(presenceOf('some_future_tool')).toEqual({ activity: 'cutting', target: 'monitor' });
  });

  it('素材总时长：只算有效时长，取整；都没有时为空', () => {
    expect(totalFootageSeconds(['6.0', '6.4', null])).toBe(12);
    expect(totalFootageSeconds([null, 'x'])).toBeNull();
  });
});
