import { describe, expect, it } from 'vitest';
import {
  artifactSchema,
  capabilitiesResponseSchema,
  handoffDescriptorSchema,
  outputPlanSchema,
  packManifestSchema,
  publicationKeySchema,
  publicationRequestSchema,
  PUBLICATION_STATES,
  PUBLISH_CAPABILITY_TIERS,
  validationResultSchema,
} from './index.js';

const validManifest = {
  manifestVersion: '1.0',
  packId: 'ancs.pack.shorts',
  name: 'Shorts Pack',
  version: '0.1.0',
  capabilities: ['read_content_core', 'create_scene_graph'],
  compatibility: { coreRange: '>=0.1.0 <1.0.0' },
};

describe('扩展契约（§92 / P01-06）', () => {
  it('PackManifest：默认值填充（capabilities/outputFormats/quota/signature）', () => {
    const parsed = packManifestSchema.parse(validManifest);
    expect(parsed.outputFormats).toEqual([]);
    expect(parsed.quota).toBeNull();
    expect(parsed.signature).toBeNull();
    expect(parsed.compatibility.sceneGraphSchemaVersion).toBeNull();
  });

  it('PackManifest：packId 必须为反向域名式；非法能力被拒', () => {
    expect(packManifestSchema.safeParse({ ...validManifest, packId: 'Shorts' }).success).toBe(false);
    expect(
      packManifestSchema.safeParse({ ...validManifest, capabilities: ['root_access'] }).success,
    ).toBe(false);
  });

  it('OutputPlan / Artifact / ValidationResult 往返无损', () => {
    const plan = outputPlanSchema.parse({ schemaVersion: '0.1', summary: '生成 3 条竖屏短片' });
    expect(plan.requiresApproval).toBe(true);
    const reparsed = outputPlanSchema.parse(JSON.parse(JSON.stringify(plan)) as unknown);
    expect(reparsed).toEqual(plan);

    const artifact = artifactSchema.parse({
      artifactId: 'art_1',
      kind: 'video',
      title: '短片 1',
      createdAt: '2026-10-04T00:00:00.000Z',
    });
    expect(artifact.metadata).toEqual({});

    const validation = validationResultSchema.parse({
      ok: false,
      issues: [{ severity: 'error', code: 'OVERFLOW', message: '文本越界' }],
    });
    expect(validation.issues[0]?.artifactId).toBeNull();
  });

  it('HandoffDescriptor：状态枚举与必填 artifactIds', () => {
    const descriptor = handoffDescriptorSchema.parse({
      handoffId: 'ho_1',
      state: 'PENDING',
      artifactIds: ['art_1'],
      expiresAt: '2026-10-05T00:00:00.000Z',
      createdAt: '2026-10-04T00:00:00.000Z',
    });
    expect(descriptor.targetPlatform).toBeNull();
    expect(
      handoffDescriptorSchema.safeParse({ ...descriptor, artifactIds: [] }).success,
    ).toBe(false);
    expect(handoffDescriptorSchema.safeParse({ ...descriptor, state: 'SENT' }).success).toBe(false);
  });
});

describe('发布契约（§42 / §90；DEC-06：V1=契约级）', () => {
  it('Capability Tier 为 P1—P4 四档', () => {
    expect([...PUBLISH_CAPABILITY_TIERS]).toEqual([
      'P1_DIRECT_PUBLISH',
      'P2_AUTHORIZED_PUBLISH',
      'P3_UPLOAD_DRAFT',
      'P4_EXPORT_PACKAGE',
    ]);
  });

  it('发布幂等键为 §90 的四元组', () => {
    const key = publicationKeySchema.parse({
      platformId: 'youtube',
      accountId: 'acc_1',
      projectVersionId: 'pv_1',
      outputAssetId: 'ast_out_1',
    });
    expect(key.platformId).toBe('youtube');
    expect(
      publicationKeySchema.safeParse({ platformId: 'youtube', accountId: 'acc_1' }).success,
    ).toBe(false);
  });

  it('PublicationRequest 默认值与状态枚举', () => {
    const request = publicationRequestSchema.parse({
      publicationKey: { platformId: 'youtube', accountId: 'acc_1', projectVersionId: 'pv_1', outputAssetId: 'ast_1' },
      title: '标题',
    });
    expect(request.tags).toEqual([]);
    expect(request.scheduledAt).toBeNull();
    expect(request.disclosure).toBeNull();
    expect([...PUBLICATION_STATES]).toEqual([
      'DRAFT',
      'QUEUED',
      'PUBLISHING',
      'PUBLISHED',
      'FAILED',
      'DELETED_REMOTE',
    ]);
  });

  it('capabilitiesResponse：未查询格式时 availability 为 null；快照结构可解析', () => {
    const response = capabilitiesResponseSchema.parse({ packs: [], distributionProviders: [], outputFormats: [] });
    expect(response.outputFormatAvailability).toBeNull();
    const probed = capabilitiesResponseSchema.parse({
      packs: [],
      distributionProviders: [],
      outputFormats: [],
      outputFormatAvailability: { format: 'shorts_9x16', available: false, reason: '未安装提供该输出格式的 Pack' },
    });
    expect(probed.outputFormatAvailability?.available).toBe(false);
  });
});
