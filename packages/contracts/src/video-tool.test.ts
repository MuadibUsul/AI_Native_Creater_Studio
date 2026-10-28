import { describe, expect, it } from 'vitest';
import type { AgentToolDescriptor } from './agent.js';
import {
  VIDEO_BRIDGE_TOKEN_MAX_TTL_SECONDS,
  VIDEO_TOOL_MAX_ARGS_BYTES,
  VIDEO_TOOL_MAX_CONTENT_CHARS,
  VIDEO_TOOL_PROTOCOL_VERSION,
  videoBridgeTokenClaimsSchema,
  videoToolDescriptorOf,
  videoToolDescriptorSchema,
  videoToolExecutionSchema,
  videoToolInvocationSchema,
  videoToolResultSchema,
} from './video-tool.js';

const descriptor = (overrides: Partial<AgentToolDescriptor> = {}): AgentToolDescriptor => ({
  name: 'get_timeline',
  capability: 'timeline.read',
  description: 'Read the draft timeline.',
  effect: 'READ',
  permission: 'project:read',
  metered: false,
  inputSchema: { type: 'object', properties: {} },
  ...overrides,
});

const invocation = (overrides: Record<string, unknown> = {}) => ({
  protocolVersion: VIDEO_TOOL_PROTOCOL_VERSION,
  correlationId: 'req-1',
  commandId: 'call_01:edit_timeline',
  sessionId: 'ags_1',
  turnId: 'agt_1',
  workspaceId: 'ws_1',
  projectId: 'prj_1',
  expectedProjectRevision: 4,
  toolName: 'edit_timeline',
  args: { operations: [] },
  ...overrides,
});

const result = (overrides: Record<string, unknown> = {}) => ({
  protocolVersion: VIDEO_TOOL_PROTOCOL_VERSION,
  commandId: 'call_01:edit_timeline',
  correlationId: 'req-1',
  status: 'OK',
  rejectReason: null,
  replayed: false,
  content: '{"ok":true}',
  summary: 'inserted 3 clips',
  images: [],
  projectRevision: 4,
  draft: { baseRevision: 4, operations: 3, changed: true },
  traceId: 'trace-1',
  ...overrides,
});

describe('video-tool.v1 descriptors', () => {
  it('keeps the ANCS descriptor and derives concurrency and deadline from it', () => {
    const read = videoToolDescriptorOf(descriptor());
    expect(read).toMatchObject({ name: 'get_timeline', effect: 'READ', protocolVersion: 'video-tool.v1', concurrencySafe: true, timeoutMs: 120_000 });
    expect(read.inputSchema).toEqual({ type: 'object', properties: {} });
    expect(videoToolDescriptorOf(descriptor({ name: 'look_at_footage', capability: 'footage.look' })).timeoutMs).toBe(300_000);
    for (const effect of ['DRAFT_EDIT', 'PLAN', 'GENERATE'] as const) {
      expect(videoToolDescriptorOf(descriptor({ name: 'edit_timeline', effect, permission: 'project:write', metered: effect === 'GENERATE' })).concurrencySafe).toBe(false);
    }
  });

  it('is strict and versioned', () => {
    const valid = videoToolDescriptorOf(descriptor());
    expect(videoToolDescriptorSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
    expect(videoToolDescriptorSchema.safeParse({ ...valid, protocolVersion: 'video-tool.v2' }).success).toBe(false);
  });
});

describe('video-tool.v1 invocation', () => {
  it('accepts a well-formed call', () => {
    expect(videoToolInvocationSchema.parse(invocation())).toMatchObject({ toolName: 'edit_timeline', expectedProjectRevision: 4 });
  });

  it.each([
    ['an unknown protocol version', { protocolVersion: 'video-tool.v0' }],
    ['an unknown field', { traceparent: 'x' }],
    ['a command id with unsafe characters', { commandId: 'call 1/../x' }],
    ['a negative revision', { expectedProjectRevision: -1 }],
    ['a tool name that is not snake_case', { toolName: 'Edit-Timeline' }],
    ['args that are not an object', { args: ['edit'] }],
  ])('rejects %s', (_label, overrides) => {
    expect(videoToolInvocationSchema.safeParse(invocation(overrides)).success).toBe(false);
  });

  it('rejects args over the size limit instead of truncating them', () => {
    const big = invocation({ args: { text: 'x'.repeat(VIDEO_TOOL_MAX_ARGS_BYTES) } });
    const parsed = videoToolInvocationSchema.safeParse(big);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(['args']);
  });
});

describe('video-tool.v1 result', () => {
  it('accepts OK, TOOL_ERROR and a replay', () => {
    expect(videoToolResultSchema.safeParse(result()).success).toBe(true);
    expect(videoToolResultSchema.safeParse(result({ status: 'TOOL_ERROR', content: '{"error":"invalid input"}', draft: { baseRevision: 4, operations: 0, changed: false } })).success).toBe(true);
    expect(videoToolResultSchema.safeParse(result({ replayed: true })).success).toBe(true);
  });

  it('pairs REJECTED with a reason, and a rejected call never changes the draft', () => {
    const rejected = { status: 'REJECTED', rejectReason: 'TURN_NOT_RUNNING', content: '', summary: 'turn ended', draft: { baseRevision: 4, operations: 3, changed: false } };
    expect(videoToolResultSchema.safeParse(result(rejected)).success).toBe(true);
    expect(videoToolResultSchema.safeParse(result({ ...rejected, rejectReason: null })).success).toBe(false);
    expect(videoToolResultSchema.safeParse(result({ rejectReason: 'UNKNOWN_TOOL' })).success).toBe(false);
    expect(videoToolResultSchema.safeParse(result({ ...rejected, draft: { baseRevision: 4, operations: 3, changed: true } })).success).toBe(false);
  });

  it('rejects malformed or oversized results (T24)', () => {
    expect(videoToolResultSchema.safeParse(result({ content: 'x'.repeat(VIDEO_TOOL_MAX_CONTENT_CHARS + 1) })).success).toBe(false);
    const frame = { mediaType: 'image/jpeg', data: 'AAAA' };
    expect(videoToolResultSchema.safeParse(result({ images: Array.from({ length: 17 }, () => frame) })).success).toBe(false);
    expect(videoToolResultSchema.safeParse(result({ images: [{ mediaType: 'image/gif', data: 'AAAA' }] })).success).toBe(false);
    expect(videoToolResultSchema.safeParse(result({ adopted: true })).success).toBe(false);
    expect(videoToolResultSchema.safeParse(result({ projectRevision: 1.5 })).success).toBe(false);
  });
});

describe('video-tool.v1 execution record', () => {
  const record = { protocolVersion: VIDEO_TOOL_PROTOCOL_VERSION, commandId: 'call_01:edit_timeline', turnId: 'agt_1', toolName: 'edit_timeline', argsHash: 'a'.repeat(64) };

  it('carries a result exactly when the call committed', () => {
    expect(videoToolExecutionSchema.safeParse({ ...record, state: 'COMMITTED', result: result() }).success).toBe(true);
    expect(videoToolExecutionSchema.safeParse({ ...record, state: 'COMMITTED', result: null }).success).toBe(false);
    for (const state of ['NOT_STARTED', 'RUNNING', 'FAILED', 'UNKNOWN']) {
      expect(videoToolExecutionSchema.safeParse({ ...record, state, result: null }).success).toBe(true);
      expect(videoToolExecutionSchema.safeParse({ ...record, state, result: result() }).success).toBe(false);
    }
  });
});

describe('bridge token claims', () => {
  const claims = { v: 1, aud: 'ancs-video-bridge', workspaceId: 'ws_1', projectId: 'prj_1', sessionId: 'ags_1', turnId: 'agt_1', purpose: 'EDIT', iat: 1_000, exp: 1_000 + 1800, jti: 'jti_0123456789abcdef' };

  it('binds one turn for a bounded time', () => {
    expect(videoBridgeTokenClaimsSchema.safeParse(claims).success).toBe(true);
    expect(videoBridgeTokenClaimsSchema.safeParse({ ...claims, exp: claims.iat }).success).toBe(false);
    expect(videoBridgeTokenClaimsSchema.safeParse({ ...claims, exp: claims.iat + VIDEO_BRIDGE_TOKEN_MAX_TTL_SECONDS + 1 }).success).toBe(false);
  });

  it('rejects another audience, an unknown purpose or extra grants', () => {
    expect(videoBridgeTokenClaimsSchema.safeParse({ ...claims, aud: 'ancs-api' }).success).toBe(false);
    expect(videoBridgeTokenClaimsSchema.safeParse({ ...claims, purpose: 'ADMIN' }).success).toBe(false);
    expect(videoBridgeTokenClaimsSchema.safeParse({ ...claims, scopes: ['project:write'] }).success).toBe(false);
  });
});
