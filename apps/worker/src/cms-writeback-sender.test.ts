import { describe, expect, it } from 'vitest';
import { CMS_WRITEBACK_EVENT_TYPE, type CmsWritebackPayload } from '@ancs/contracts';
import { canonicalizeCmsWritebackPayload } from '@ancs/domain';
import { createHttpCmsWritebackSender } from './cms-writeback-sender.js';

const payload: CmsWritebackPayload = {
  schemaVersion: '1.0',
  eventType: CMS_WRITEBACK_EVENT_TYPE,
  deliveryId: 'cmsd_test',
  occurredAt: '2026-10-07T00:00:00.000Z',
  workspaceId: 'ws_test',
  source: { type: 'CMS_WEBHOOK', externalId: 'article-1' },
  artifact: {
    projectId: 'prj_test',
    projectVersionId: 'pv_test',
    renderId: 'rnd_test',
    renderStatus: 'READY',
    approvalRequired: true,
    manifestHash: 'abc',
    outputAssetIds: ['asset_test'],
  },
};

describe('CMS writeback sender', () => {
  it('canonical JSON 对键顺序稳定', () => {
    const first = canonicalizeCmsWritebackPayload(payload);
    const reordered = canonicalizeCmsWritebackPayload(JSON.parse(JSON.stringify(payload)) as CmsWritebackPayload);
    expect(reordered).toBe(first);
    expect(first).toContain('"approvalRequired":true');
  });

  it('拒绝 URL 字面量私网与 DNS 解析出的私网地址', async () => {
    const sender = createHttpCmsWritebackSender({ lookup: async () => [{ address: '10.0.0.7', family: 4 }] });
    await expect(sender.send({ url: 'http://127.0.0.1/callback', headers: {}, body: '{}', timeoutMs: 10, maxResponseBytes: 16 })).rejects.toMatchObject({ httpStatus: 403 });
    await expect(sender.send({ url: 'https://cms.example/callback', headers: {}, body: '{}', timeoutMs: 10, maxResponseBytes: 16 })).rejects.toMatchObject({ httpStatus: 403 });
  });
});
