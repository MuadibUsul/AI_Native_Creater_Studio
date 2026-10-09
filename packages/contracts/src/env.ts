import { z } from 'zod';

/**
 * 部署环境配置契约（P08-01 / 规范 §50；计划 §8 P08-01）。
 *
 * 纪律（验收："错误配置启动失败并说明原因"）：
 * - **fail-closed 且一次说全**：启动时收集**全部**问题（缺失/非法/未实现的驱动名），
 *   一次性打印可操作的中文清单后退出（非"改一个报一个"）；
 * - 未实现的驱动/适配器（如 s3/r2、真实 Provider 驱动）必须**显式失败**——绝不静默降级为 Mock；
 * - 本模块只做配置**校验与解释**（平台中立；不读取进程 env、不依赖具体适配器实现）。
 */

export interface EnvIssue {
  variable: string;
  message: string;
}

export interface EnvValidationResult<T> {
  ok: boolean;
  value: T | null;
  issues: EnvIssue[];
}

/**
 * 校验环境配置（收集全部问题；不抛异常——由调用方决定退出）。
 * `env` 为待校验的原始键值（通常是 process.env 的白名单切片）。
 */
export function validateEnv<Shape extends z.ZodRawShape>(schema: z.ZodObject<Shape>, env: Record<string, string | undefined>): EnvValidationResult<z.infer<z.ZodObject<Shape>>> {
  const parsed = schema.safeParse(env);
  if (parsed.success) {
    return { ok: true, value: parsed.data, issues: [] };
  }
  const issues: EnvIssue[] = parsed.error.issues.map((issue) => ({
    variable: issue.path.length > 0 ? issue.path.join('.') : '(env)',
    message: issue.message,
  }));
  // 去重（同一变量多条信息合并展示）
  const seen = new Set<string>();
  const unique = issues.filter((issue) => {
    const key = `${issue.variable}:${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((left, right) => left.variable.localeCompare(right.variable));
  return { ok: false, value: null, issues: unique };
}

/** 启动失败的可打印清单（"错误配置启动失败并说明原因"的格式规范）。 */
export function formatEnvFailure(app: string, issues: readonly EnvIssue[]): string {
  const lines = [`[${app}] 启动失败：环境配置有 ${String(issues.length)} 处问题（fail-closed，拒绝带病启动）：`];
  for (const issue of issues) {
    lines.push(`  - ${issue.variable}：${issue.message}`);
  }
  lines.push('  参考：docs/ops/deployment-runbook.md（环境变量清单与示例 .env.example）。');
  return lines.join('\n');
}

const nonEmpty = (label: string): z.ZodString => z.string().min(1, `${label} 未配置`);

/** API 与 Worker 共用的基础连接配置。 */
export const baseEnvShape = {
  DATABASE_URL: nonEmpty('DATABASE_URL（PostgreSQL 连接串）'),
  BETTER_AUTH_SECRET: z.string().min(16, 'BETTER_AUTH_SECRET 未配置或过短（≥16 字符；经 KMS/Secrets 注入，禁止入库）'),
} satisfies z.ZodRawShape;

/** API 服务环境（apps/api）。 */
export const apiEnvSchema = z.object({
  ...baseEnvShape,
  NODE_ENV: z.enum(['development', 'test', 'production']).optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  BETTER_AUTH_URL: z.string().url('BETTER_AUTH_URL 必须是完整 URL（如 https://api.example.com）').optional(),
  /** 存储驱动：V1 仅 local（S3/R2 适配器未实现 → 明确失败，不静默降级） */
  ANCS_STORAGE_DRIVER: z.enum(['local'], { message: 'ANCS_STORAGE_DRIVER 仅支持 local（S3/R2 适配器属后续阶段）' }).default('local'),
  ANCS_STORAGE_SECRET: z.string().min(16, 'ANCS_STORAGE_SECRET 过短（≥16 字符）').optional(),
  ANCS_STORAGE_LOCAL_DIR: nonEmpty('ANCS_STORAGE_LOCAL_DIR').optional(),
  ANCS_STORAGE_PUBLIC_BASE_URL: z.string().url('ANCS_STORAGE_PUBLIC_BASE_URL 必须是完整 URL').optional(),
  /** LLM 驱动：V1 仅 mock（真实适配器需凭据 → 未实现驱动名明确失败） */
  ANCS_LLM_DRIVER: z.enum(['mock'], { message: 'ANCS_LLM_DRIVER 仅支持 mock（真实 LLM 适配器随凭据接入）' }).default('mock'),
  /** TTS 驱动：V1 仅 mock */
  ANCS_TTS_DRIVER: z.enum(['mock'], { message: 'ANCS_TTS_DRIVER 仅支持 mock（真实 TTS 适配器随凭据接入）' }).default('mock'),
  /** 原生客户端注册（JSON 数组；由 parseNativeClients 进一步校验） */
  ANCS_NATIVE_CLIENTS: z.string().optional(),
  /** Webhook 验签密钥（JSON；由 parseWebhookVerifiers 进一步校验） */
  ANCS_WEBHOOK_SECRETS: z.string().optional(),
  /** 平台托管 Provider 凭据（JSON；仅后端使用） */
  PLATFORM_PROVIDER_KEYS: z.string().optional(),
  /** 历史兼容配置；N15-02 起不再授予运营权限。管理员身份由 admin_principals + role_grants 决定。 */
  ANCS_PLATFORM_ADMINS: z.string().optional(),
  ANCS_OPS_ENVIRONMENT: z.enum(['DEVELOPMENT', 'TEST', 'STAGING', 'PRODUCTION']).optional(),
  ANCS_OPS_IDLE_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  ANCS_OPS_ABSOLUTE_SECONDS: z.coerce.number().int().min(300).max(86400).default(28800),
  ANCS_OPS_REAUTH_SECONDS: z.coerce.number().int().min(30).max(1800).default(300),
  /** 未订阅 workspace 的默认套餐（P09-01；预上线默认 ENTERPRISE；**SaaS 上线门（P09-06）要求 FREE**） */
  ANCS_DEFAULT_PLAN: z.enum(['FREE', 'CREATOR', 'PRO', 'STUDIO', 'ENTERPRISE'], { message: 'ANCS_DEFAULT_PLAN 仅支持 FREE/CREATOR/PRO/STUDIO/ENTERPRISE' }).optional(),
  /** 收款驱动（P09-02）：mock=脚本化（仅开发/测试，警告）；stripe 需凭据（未实现→启动失败）；缺省=未配置（收款端点 501 fail-closed） */
  ANCS_PAYMENTS_DRIVER: z.enum(['mock', 'stripe'], { message: 'ANCS_PAYMENTS_DRIVER 仅支持 mock | stripe' }).optional(),
  /** Mock 收款签名密钥（ANCS_PAYMENTS_DRIVER=mock 时必填；≥16） */
  ANCS_PAYMENTS_MOCK_SECRET: z.string().min(16, 'ANCS_PAYMENTS_MOCK_SECRET 过短（≥16 字符）').optional(),
  /**
   * 运行模式（P09-06 商业上线门）：internal（默认；预上线内部用）| live（对外 SaaS）。
   * **live = fail-closed 门禁**：正式收款/公开注册所需的机器条件必须全部满足（见 crossCheckApiEnv），
   * 否则启动失败——"所需外部条件完成后才能开启正式收款和公开注册"（计划 §8）。
   * 人工条件（条款/主体/政策文档）台账见 docs/ops/launch-gate.md（scripts/launch-gate-check.mjs --live 校验）。
   */
  ANCS_SAAS_MODE: z.enum(['internal', 'live'], { message: 'ANCS_SAAS_MODE 仅支持 internal | live' }).default('internal'),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;

/** 跨字段规则（API；schema 之外的可读校验；返回全部问题）。 */
export function crossCheckApiEnv(value: ApiEnv): EnvIssue[] {
  const issues: EnvIssue[] = [];
  if (value.NODE_ENV === 'production' && value.ANCS_OPS_ENVIRONMENT !== 'PRODUCTION') {
    issues.push({ variable: 'ANCS_OPS_ENVIRONMENT', message: '生产进程必须显式配置 PRODUCTION 运营环境' });
  }
  if (value.NODE_ENV !== 'production' && value.ANCS_OPS_ENVIRONMENT === 'PRODUCTION') {
    issues.push({ variable: 'ANCS_OPS_ENVIRONMENT', message: '非生产进程不得签发 PRODUCTION 运营会话' });
  }
  if (value.ANCS_SAAS_MODE === 'live') {
    if (value.ANCS_DEFAULT_PLAN !== 'FREE') {
      issues.push({
        variable: 'ANCS_DEFAULT_PLAN',
        message: `live 模式必须为 FREE（当前 ${value.ANCS_DEFAULT_PLAN ?? '未配置（将按 ENTERPRISE 解析）'}）——未订阅工作区不得获得内部不限额度`,
      });
    }
    if (value.ANCS_PAYMENTS_DRIVER !== 'stripe') {
      issues.push({
        variable: 'ANCS_PAYMENTS_DRIVER',
        message: 'live 模式必须为真实收款驱动（stripe）——mock 无真实扣款能力，不得承载正式收款',
      });
    }
    if (value.ANCS_STORAGE_DRIVER === 'local') {
      issues.push({
        variable: 'ANCS_STORAGE_DRIVER',
        message: 'live 模式不得使用 local 存储（需 S3/R2 等对象存储适配器——未实现前不得开启 SaaS）',
      });
    }
    if (value.BETTER_AUTH_URL === undefined || !value.BETTER_AUTH_URL.startsWith('https://')) {
      issues.push({ variable: 'BETTER_AUTH_URL', message: 'live 模式的 BETTER_AUTH_URL 必须是 https 完整 URL' });
    }
    if (value.ANCS_OPS_ENVIRONMENT !== 'PRODUCTION') {
      issues.push({ variable: 'ANCS_OPS_ENVIRONMENT', message: 'live 模式的运营会话必须标记 PRODUCTION' });
    }
  }
  return issues;
}

/** Worker 环境（apps/worker）。 */
export const workerEnvSchema = z.object({
  ...baseEnvShape,
  /** 队列驱动：db（默认，权威状态轮询）| bullmq（需 REDIS_URL） */
  ANCS_QUEUE_DRIVER: z.enum(['db', 'bullmq'], { message: 'ANCS_QUEUE_DRIVER 仅支持 db | bullmq' }).default('db'),
  REDIS_URL: z.string().url('REDIS_URL 必须是完整 URL（如 redis://localhost:6379）').optional(),
  ANCS_STORAGE_SECRET: z.string().min(16, 'ANCS_STORAGE_SECRET 过短（≥16 字符）').optional(),
  ANCS_STORAGE_LOCAL_DIR: nonEmpty('ANCS_STORAGE_LOCAL_DIR').optional(),
  ANCS_STORAGE_PUBLIC_BASE_URL: z.string().url('ANCS_STORAGE_PUBLIC_BASE_URL 必须是完整 URL').optional(),
  REMOTION_BROWSER_EXECUTABLE: nonEmpty('REMOTION_BROWSER_EXECUTABLE').optional(),
  ANCS_RENDER_EXECUTOR_CMD: nonEmpty('ANCS_RENDER_EXECUTOR_CMD').optional(),
  ANCS_MOTION_VALIDATOR_CMD: nonEmpty('ANCS_MOTION_VALIDATOR_CMD').optional(),
  ANCS_MEDIA_PROBE_CMD: nonEmpty('ANCS_MEDIA_PROBE_CMD').optional(),
  /** ASR 子进程协议：最后一个参数为源文件路径，stdout 返回 GeneratedMediaTranscript JSON。 */
  ANCS_ASR_EXECUTABLE: nonEmpty('ANCS_ASR_EXECUTABLE').optional(),
  ANCS_ASR_ARGS_JSON: z.string().refine((value) => { try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string'); } catch { return false; } }, 'ANCS_ASR_ARGS_JSON 必须是字符串数组 JSON').optional(),
  /** 视觉分析子进程协议：最后一个参数为源文件路径，stdout 返回 GeneratedMediaVisualAnalysis JSON。 */
  ANCS_VISUAL_ANALYSIS_EXECUTABLE: nonEmpty('ANCS_VISUAL_ANALYSIS_EXECUTABLE').optional(),
  ANCS_VISUAL_ANALYSIS_ARGS_JSON: z.string().refine((value) => { try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string'); } catch { return false; } }, 'ANCS_VISUAL_ANALYSIS_ARGS_JSON 必须是字符串数组 JSON').optional(),
  /** 音频事件分析子进程协议：最后一个参数为源文件路径，stdout 返回 GeneratedMediaAudioAnalysis JSON。 */
  ANCS_AUDIO_ANALYSIS_EXECUTABLE: nonEmpty('ANCS_AUDIO_ANALYSIS_EXECUTABLE').optional(),
  ANCS_AUDIO_ANALYSIS_ARGS_JSON: z.string().refine((value) => { try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string'); } catch { return false; } }, 'ANCS_AUDIO_ANALYSIS_ARGS_JSON 必须是字符串数组 JSON').optional(),
  ANCS_DISABLE_RENDER: z.enum(['0', '1']).optional(),
  ANCS_WORKER_ONCE: z.enum(['0', '1']).optional(),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/** 跨字段规则（schema 之外的可读校验；返回全部问题）。 */
export function crossCheckWorkerEnv(value: WorkerEnv): EnvIssue[] {
  const issues: EnvIssue[] = [];
  if (value.ANCS_QUEUE_DRIVER === 'bullmq' && value.REDIS_URL === undefined) {
    issues.push({ variable: 'REDIS_URL', message: 'ANCS_QUEUE_DRIVER=bullmq 时必须配置 REDIS_URL' });
  }
  return issues;
}
