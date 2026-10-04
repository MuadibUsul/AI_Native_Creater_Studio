import { describe, expect, it } from 'vitest';
import { contentDocumentSchema } from './index.js';

const minimalDoc = {
  schemaVersion: '0.1',
  id: 'doc_test',
  title: '测试文档',
  language: 'zh-CN',
  blocks: [{ id: 'blk_1', type: 'paragraph', text: '正文内容' }],
};

describe('ContentDocument 契约', () => {
  it('最小文档通过校验且 defaults 正确填充（claims/figures/extractions）', () => {
    const doc = contentDocumentSchema.parse(minimalDoc);
    expect(doc.claims).toEqual([]);
    expect(doc.citations).toEqual([]);
    expect(doc.figures).toEqual([]);
    expect(doc.extractions.entities).toEqual([]);
    expect(doc.extractions.numericFacts).toEqual([]);
  });

  it('往返无损（defaults 填充后为标准不动点）', () => {
    const once = contentDocumentSchema.parse(minimalDoc);
    const twice = contentDocumentSchema.parse(JSON.parse(JSON.stringify(once)) as unknown);
    expect(twice).toEqual(once);
  });

  it('完整结构可解析：块 / Claim / 引用 / 表格 / 抽取结构', () => {
    const doc = contentDocumentSchema.parse({
      ...minimalDoc,
      blocks: [
        { id: 'blk_1', type: 'heading', level: 1, text: '标题' },
        { id: 'blk_2', type: 'table', table: { columns: ['指标', '值'], rows: [['赤字', '5.5%']] } },
      ],
      claims: [
        {
          id: 'clm_1',
          text: '赤字占 GDP 5.5%。',
          factuality: 'fact',
          sourceIds: ['src_1'],
          structuredData: [{ datasetId: 'ds_1', seriesId: 's_1' }],
        },
      ],
      citations: [{ id: 'cit_1', claimId: 'clm_1', sourceId: 'src_1', locator: '摘要' }],
      tables: [{ id: 'tbl_1', blockId: 'blk_2', caption: '财政指标', datasetId: 'ds_1' }],
      extractions: {
        entities: [{ id: 'ent_1', name: '法国', kind: 'COUNTRY' }],
        causalRelations: [{ id: 'rel_1', cause: '政治不确定性', effect: '风险溢价上行', claimIds: ['clm_1'] }],
        timelineEvents: [{ id: 'tev_1', date: '2024-06-09', description: '解散国民议会', claimIds: [] }],
        geography: [{ id: 'geo_1', countryCodes: ['FRA'], description: '法国' }],
        numericFacts: [{ id: 'nf_1', value: 5.5, unit: '% of GDP', timeRange: { from: '2023', to: '2023' }, claimIds: ['clm_1'] }],
      },
    });
    expect(doc.blocks).toHaveLength(2);
    expect(doc.extractions.numericFacts[0]?.unit).toBe('% of GDP');
  });

  it('非法值被拒：非法 factuality / 未知块类型 / 空 blocks / 缺 schemaVersion', () => {
    expect(
      contentDocumentSchema.safeParse({
        ...minimalDoc,
        claims: [{ id: 'c', text: 'x', factuality: 'rumor', sourceIds: [] }],
      }).success,
    ).toBe(false);
    expect(
      contentDocumentSchema.safeParse({ ...minimalDoc, blocks: [{ id: 'b', type: 'video' }] }).success,
    ).toBe(false);
    expect(contentDocumentSchema.safeParse({ ...minimalDoc, blocks: [] }).success).toBe(false);

    const { schemaVersion: _omitted, ...withoutVersion } = minimalDoc;
    expect(contentDocumentSchema.safeParse(withoutVersion).success).toBe(false);
  });
});
