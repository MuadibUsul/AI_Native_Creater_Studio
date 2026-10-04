#!/usr/bin/env node
/**
 * 独立客户端示例（P01-05）：不启动 Web，仅用 SDK 完成授权后的完整读写。
 *
 * 演示：
 *  1. Cookie 会话：登录 → 建租户 → 建栏目 → 改样式（验证旧快照不变）→ 身份/风格读写
 *  2. 原生 PKCE：授权码兑换 → Bearer 会话 → Bearer 写入 → 撤销（随后立即 401）
 *
 * 用法（需先启动 API 并创建内部账号；完整步骤见本目录 README）：
 *   ANCS_API_URL=http://127.0.0.1:3001 ANCS_EMAIL=... ANCS_PASSWORD=... \
 *     node examples/standalone-client/run.mjs
 */
import { createClient, generatePkcePair } from '../../packages/sdk/dist/index.js';

const baseUrl = process.env.ANCS_API_URL ?? 'http://127.0.0.1:3001';
const email = process.env.ANCS_EMAIL;
const password = process.env.ANCS_PASSWORD;

async function main() {
  if (email === undefined || password === undefined) {
    throw new Error('需要环境变量 ANCS_EMAIL / ANCS_PASSWORD（内部账号；创建方式见 packages/auth 的 create-user CLI）');
  }

  const client = createClient({ baseUrl, clientType: 'desktop', clientVersion: '0.1.0-demo' });

  const health = await client.health();
  console.log(`[1] health: ${health.status}（${health.service} v${health.version}）`);

  const signIn = await client.auth.signIn({ email, password });
  console.log(`[2] 登录完成（Cookie 会话）：${signIn.user.email}`);

  const session = await client.auth.session();
  console.log(`[3] 会话方式：${session.method}`);

  const suffix = Date.now().toString(36);
  const workspace = await client.workspaces.create(
    { name: `独立客户端示范-${suffix}` },
    { idempotencyKey: `idem_demo_ws_${suffix}` },
  );
  console.log(`[4] 创建租户：${workspace.id}（role=${workspace.role}）`);

  const channel = await client.channels.create(workspace.id, {
    name: '财经栏目',
    defaults: { aiVideoRatioMax: 0.15 },
  });
  console.log(
    `[5] 创建栏目：${channel.id} styleVersion=v${channel.currentStyleVersion} aiVideoRatioMax=${channel.styleVersion.defaults.aiVideoRatioMax}`,
  );

  const updated = await client.channels.update(workspace.id, channel.id, { defaults: { aiVideoRatioMax: 0.05 } });
  const versions = await client.channels.styleVersions(workspace.id, channel.id);
  const v1 = versions.find((v) => v.version === 1);
  console.log(
    `[6] 更新样式：v${updated.currentStyleVersion} aiVideoRatioMax=${updated.styleVersion.defaults.aiVideoRatioMax}；旧快照 v1 仍为 ${String(v1?.defaults.aiVideoRatioMax)}`,
  );

  const identity = await client.creatorIdentities.create(workspace.id, { displayName: `示范主持人-${suffix}` });
  const withVoice = await client.creatorIdentities.update(workspace.id, identity.id, {
    voiceIdentity: { provider: 'elevenlabs', providerVoiceId: 'vo_demo_1', managedMode: 'BYOK' },
  });
  console.log(`[7] 身份与声音：voiceIdentity v${String(withVoice.voiceIdentity?.version)}（${String(withVoice.voiceIdentity?.managedMode)}）`);

  const speech = await client.speechProfiles.create(workspace.id, {
    name: `示范风格-${suffix}`,
    fields: { defaultSpeed: 1.08 },
  });
  console.log(`[8] SpeechProfile：v${speech.currentVersion} defaultSpeed=${speech.latest.fields.defaultSpeed}`);

  const pkce = await generatePkcePair();
  const authorized = await client.auth.authorize({
    clientId: 'ancs-desktop',
    redirectUri: 'ancs://auth/callback',
    codeChallenge: pkce.challenge,
    state: `demo_${suffix}`,
  });
  if (authorized.code === null) {
    throw new Error(`授权未返回 code（error=${String(authorized.error)}）`);
  }
  const tokens = await client.auth.token({
    grantType: 'authorization_code',
    clientId: 'ancs-desktop',
    code: authorized.code,
    codeVerifier: pkce.verifier,
  });
  const bearerClient = createClient({
    baseUrl,
    clientType: 'desktop',
    credentials: 'omit',
    getAccessToken: () => tokens.accessToken,
  });
  const bearerSession = await bearerClient.auth.session();
  const bearerWorkspace = await bearerClient.workspaces.create({ name: `原生客户端示范-${suffix}` });
  console.log(`[9] 原生 PKCE：会话方式=${bearerSession.method}；Bearer 写入租户=${bearerWorkspace.id}`);

  await bearerClient.auth.revoke({ clientId: 'ancs-desktop', refreshToken: tokens.refreshToken });
  const afterRevoke = await bearerClient.auth.session().catch((error) => error.code);
  console.log(`[10] 撤销后访问：${String(afterRevoke)}`);

  console.log('独立客户端示例完成（全程未启动 Web）。');
}

main().catch((error) => {
  console.error(`示例执行失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
