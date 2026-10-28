import { AIGC_EXPLICIT_TEXT, contentLabelSchema, startCompositionFinalRenderRequestSchema } from '@ancs/contracts';
import { describe, expect, it } from 'vitest';
import { contentLabelFor } from './composition-final-render.js';

describe('AI 生成内容标识的语言（面向全球市场）', () => {
  it('缺省英文 "AI-generated"；指定中文用 "AI生成"；元数据与语言无关', () => {
    const english = contentLabelFor({ generatedSources: 1, runId: 'wfr_1', producerCode: undefined });
    const chinese = contentLabelFor({ generatedSources: 1, runId: 'wfr_1', producerCode: undefined, language: 'zh' });
    expect(english?.explicitText).toBe('AI-generated');
    expect(contentLabelFor({ generatedSources: 2, runId: 'wfr_1', producerCode: 'P1', language: 'en' })?.explicitText).toBe(AIGC_EXPLICIT_TEXT.en);
    expect(chinese?.explicitText).toBe('AI生成');
    expect(chinese?.metadata).toEqual(english?.metadata);
    expect(contentLabelSchema.safeParse(english).success).toBe(true);
    expect(contentLabelSchema.safeParse(chinese).success).toBe(true);
  });

  it('不含 AI 生成媒体时不加标识（与语言无关）', () => {
    expect(contentLabelFor({ generatedSources: 0, runId: 'wfr_1', producerCode: 'P1', language: 'zh' })).toBeNull();
  });

  it('标识文字只接受固定文案；导出请求只接受支持的语言', () => {
    const label = contentLabelFor({ generatedSources: 1, runId: 'wfr_1', producerCode: undefined })!;
    expect(contentLabelSchema.safeParse({ ...label, explicitText: 'Made with AI' }).success).toBe(false);
    expect(startCompositionFinalRenderRequestSchema.safeParse({ profile: { width: 1920, height: 1080 }, labelLanguage: 'en' }).success).toBe(true);
    expect(startCompositionFinalRenderRequestSchema.safeParse({ profile: { width: 1920, height: 1080 }, labelLanguage: 'de' }).success).toBe(false);
  });
});
