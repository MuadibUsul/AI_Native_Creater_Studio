import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  channelWithStyleSchema,
  contentDocumentSchema,
  creatorIdentitySchema,
  editRequestSchema,
  errorEnvelopeSchema,
  eventEnvelopeSchema,
  healthResponseSchema,
  moneySchema,
  pageRequestSchema,
  sceneGraphSchema,
  sourceSnapshotSchema,
  speechProfileSchema,
  structuredDatasetSchema,
  versionConflictDetailsSchema,
  workspaceWithRoleSchema,
} from './index.js';

/**
 * 验收条款"生成 OpenAPI"的契约侧证据：
 * 所有公开 schema 必须可转换为 JSON Schema（OpenAPI 组件的基础形态）。
 * 路由级 OpenAPI 文档由 apps/api 的 /openapi.json 测试覆盖。
 */
const schemaRegistry: Record<string, z.ZodType> = {
  healthResponse: healthResponseSchema,
  workspaceWithRole: workspaceWithRoleSchema,
  channelWithStyle: channelWithStyleSchema,
  creatorIdentity: creatorIdentitySchema,
  speechProfile: speechProfileSchema,
  errorEnvelope: errorEnvelopeSchema,
  versionConflictDetails: versionConflictDetailsSchema,
  eventEnvelope: eventEnvelopeSchema,
  pageRequest: pageRequestSchema,
  money: moneySchema,
  sceneGraph: sceneGraphSchema,
  contentDocument: contentDocumentSchema,
  sourceSnapshot: sourceSnapshotSchema,
  structuredDataset: structuredDatasetSchema,
  editRequest: editRequestSchema,
};

describe('JSON Schema 可生成（OpenAPI 兼容性）', () => {
  for (const [name, schema] of Object.entries(schemaRegistry)) {
    it(`${name} 可转换为 JSON Schema`, () => {
      const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
      expect(jsonSchema['type']).toBe('object');
    });
  }

  it('sceneGraph 的 JSON Schema 含关键字段与必需项', () => {
    const jsonSchema = z.toJSONSchema(sceneGraphSchema) as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(jsonSchema.properties?.['schemaVersion']).toBeDefined();
    expect(jsonSchema.properties?.['scenes']).toBeDefined();
    expect(jsonSchema.required).toEqual(
      expect.arrayContaining(['schemaVersion', 'projectId', 'scenes']),
    );
  });
});
