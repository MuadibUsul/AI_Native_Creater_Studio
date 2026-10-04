#!/usr/bin/env node
/**
 * Provider 能力核验工具（P06-01 / 规范 §13—§16、计划 §13.5 第 8 条）。
 *
 * 用途：在**有真实凭据**时，对每个 Provider 执行最小能力探测，产出核验报告
 * （能力通过/不可用/需人工 + 价格与保留策略（若接口暴露）+ 日期证据），供人工复核后写入 Catalog
 * （status=VERIFIED + verifiedAt + 实测价格）。**不可用能力保持不可用，绝不显示为可用。**
 *
 * 纪律：
 * - **默认不参与 `pnpm verify`**（避免真实费用）；必须显式运行并设置 `ANCS_PROVIDER_VERIFY=1`；
 * - 未配置凭据时：打印缺失的环境变量清单并以退出码 2 结束（"未配置" ≠ "通过"）；
 * - 探测计划来自 `scripts/provider-probes.json`（可在其中声明 endpoint/读取字段，不把未经验证的
 *   API 细节硬编码进业务代码）；每条探测只做**只读/最小**调用（列表类接口优先，不触发付费生成）；
 * - 报告写到 `.artifacts/provider-verification/<timestamp>.json` 与同名 .md（人可读证据）；
 * - 工具**不直接写数据库**：Catalog 写入仍走既有 API（人工复核报告后执行，保留审计）。
 *
 * 用法：
 *   ANCS_PROVIDER_VERIFY=1 ELEVENLABS_API_KEY=... HEYGEN_API_KEY=... node scripts/provider-verify.mjs
 *   （可用 --only elevenlabs 限定单个 Provider；--dry 只打印将执行的探测）
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

const PROBES_PATH = path.resolve(import.meta.dirname, 'provider-probes.json');
const OUT_DIR = path.resolve(import.meta.dirname, '../.artifacts/provider-verification');

const enabled = process.env.ANCS_PROVIDER_VERIFY === '1';
const dryRun = process.argv.includes('--dry');
const onlyIndex = process.argv.indexOf('--only');
const only = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : null;

/** 鉴权头构造（只在内存中使用；绝不打印/落盘明文 Key）。 */
const authHeadersFor = (provider, apiKey) => {
  switch (provider.authFlavor ?? 'bearer') {
    case 'bearer':
      return { Authorization: `Bearer ${apiKey}` };
    case 'x-api-key':
      return { 'x-api-key': apiKey };
    case 'google-key':
      return { 'x-goog-api-key': apiKey };
    default:
      return { Authorization: `Bearer ${apiKey}` };
  }
};

const loadProbes = async () => {
  try {
    const content = await readFile(PROBES_PATH, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    console.error(`[provider-verify] 无法读取探测计划 ${PROBES_PATH}：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
};

const redact = (value) => {
  if (typeof value !== 'string' || value.length <= 8) return '***';
  return `${value.slice(0, 4)}…${value.slice(-2)}（已脱敏，长度 ${String(value.length)}）`;
};

const runProbe = async (provider, probe) => {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), probe.timeoutMs ?? 15_000);
  try {
    const response = await fetch(`${provider.baseUrl}${probe.path}`, {
      method: probe.method ?? 'GET',
      headers: { ...(provider.authHeader ?? {}), ...(probe.headers ?? {}) },
      signal: controller.signal,
    });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    const ok = probe.expectStatus.includes(response.status);
    const missing = [];
    for (const key of probe.expectKeys ?? []) {
      const value = body === null ? undefined : key.split('.').reduce((current, part) => (current === undefined || current === null ? undefined : current[part]), body);
      if (value === undefined || value === null) missing.push(key);
    }
    return {
      probe: probe.id,
      capability: probe.capability,
      status: ok && missing.length === 0 ? 'PASS' : ok ? 'PARTIAL' : 'UNAVAILABLE',
      httpStatus: response.status,
      latencyMs: Date.now() - started,
      missingKeys: missing,
      note: probe.note ?? null,
      // 价格/保留策略等"若接口暴露"的字段：按 probe.extract 路径读取（缺失即未知——绝不猜测）
      extracted: Object.fromEntries(
        (probe.extract ?? []).map((key) => [
          key,
          body === null
            ? null
            : key.split('.').reduce((current, part) => (current === undefined || current === null ? undefined : current[part]), body) ?? null,
        ]),
      ),
    };
  } catch (error) {
    return {
      probe: probe.id,
      capability: probe.capability,
      status: 'UNAVAILABLE',
      httpStatus: null,
      latencyMs: Date.now() - started,
      missingKeys: probe.expectKeys ?? [],
      note: `请求失败：${error instanceof Error ? error.message : String(error)}`,
      extracted: {},
    };
  } finally {
    clearTimeout(timeout);
  }
};

const main = async () => {
  const plan = await loadProbes();
  const providers = plan.providers.filter((provider) => only === null || provider.id === only);

  // --dry：只预览探测计划（不需要凭据、不产生任何调用）
  if (dryRun) {
    for (const provider of providers) {
      console.log(`
== ${provider.displayName}（${provider.id}） 凭据环境变量：${provider.apiKeyEnv}`);
      for (const probe of provider.probes) {
        console.log(`  [dry] ${probe.id} → ${probe.method ?? 'GET'} ${provider.baseUrl}${probe.path}（能力：${probe.capability}）`);
      }
    }
    console.log('[dry] 未执行真实调用。');
    return;
  }

  // 凭据检查（未配置 → 退出码 2；不伪造通过）
  const missingEnv = [];
  for (const provider of providers) {
    const value = process.env[provider.apiKeyEnv];
    if (value === undefined || value === '') missingEnv.push(provider.apiKeyEnv);
  }
  if (missingEnv.length > 0) {
    console.error('[provider-verify] 未配置凭据，无法核验（这不代表通过）：');
    for (const name of missingEnv) console.error(`  - ${name}`);
    console.error('  配置后重新运行；预算与账号能力以前测为准（计划 §13.5 第 8 条）。');
    process.exit(2);
  }
  if (!enabled) {
    console.error('[provider-verify] 需要显式开启：ANCS_PROVIDER_VERIFY=1（真实调用会产生费用/配额消耗）。');
    console.error('  仅预览探测计划：加 --dry。');
    process.exit(2);
  }

  await mkdir(OUT_DIR, { recursive: true });
  const report = { generatedAt: new Date().toISOString(), providers: [] };

  for (const provider of providers) {
    const apiKey = process.env[provider.apiKeyEnv];
    console.log(`\n== ${provider.displayName}（${provider.id}）凭据 ${redact(apiKey)}`);
    const providerReport = { id: provider.id, displayName: provider.displayName, baseUrl: provider.baseUrl, probes: [] };
    for (const probe of provider.probes) {
      const result = await runProbe(provider, { ...probe, headers: { ...(probe.headers ?? {}), ...authHeadersFor(provider, apiKey) } });
      providerReport.probes.push(result);
      const marker = result.status === 'PASS' ? '✓' : result.status === 'PARTIAL' ? '△' : '✗';
      console.log(`  ${marker} ${probe.id}（${probe.capability}）：${result.status}${result.note === null ? '' : ` — ${result.note}`}`);
      if (result.missingKeys.length > 0) console.log(`     缺少字段：${result.missingKeys.join(', ')}`);
    }
    report.providers.push(providerReport);
  }

  if (dryRun) {
    console.log('\n[dry] 未执行真实调用。');
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(OUT_DIR, `${stamp}.json`);
  const mdPath = path.join(OUT_DIR, `${stamp}.md`);
  const mdLines = [
    `# Provider 能力核验报告（${report.generatedAt}）`,
    '',
    '> 本报告是**日期证据**：人工复核后据此写入 Catalog（status=VERIFIED + verifiedAt + 实测价格）。',
    '> 不可用能力保持不可用（`requireCallableModel` 继续 fail-closed），不得显示为可用。',
    '',
  ];
  for (const provider of report.providers) {
    mdLines.push(`## ${provider.displayName}（${provider.id}）`, '', `- Base URL：${provider.baseUrl}`, '');
    mdLines.push('| 探测 | 能力 | 结论 | HTTP | 延迟 | 缺失字段 | 提取（价格/保留策略等） |');
    mdLines.push('|---|---|---|---|---|---|---|');
    for (const probe of provider.probes) {
      mdLines.push(
        `| ${probe.probe} | ${probe.capability} | ${probe.status} | ${probe.httpStatus ?? '—'} | ${probe.latencyMs}ms | ${probe.missingKeys.join('<br>') || '—'} | ${JSON.stringify(probe.extracted)} |`,
      );
    }
    mdLines.push('');
  }
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(mdPath, mdLines.join('\n'), 'utf8');
  console.log(`\n[provider-verify] 报告已写入：\n  ${jsonPath}\n  ${mdPath}`);
  console.log('下一步：人工复核报告 → 经 Catalog API 写入核验版本（保留本报告为日期证据）。');
};

await main();
