import { z } from 'zod';
import { narrationVoiceSchema } from './narration.js';
import { generationOfferSchema } from './paid-generation.js';

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
 * 空白值视为**未配置**（与 `.env.example` 中留空的行、`VAR=` 形式的部署配置一致）：
 * 可选项回到缺省行为，必填项报告"未配置"，而不是报"过短"。
 */
export function validateEnv<Shape extends z.ZodRawShape>(schema: z.ZodObject<Shape>, env: Record<string, string | undefined>): EnvValidationResult<z.infer<z.ZodObject<Shape>>> {
  const configured = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value.trim() !== ''));
  const parsed = schema.safeParse(configured);
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

/**
 * URL 的 origin（scheme://host[:port]，小写，省略默认端口）；不是 http(s) URL 返回 null。
 * 不使用全局 `URL`：本包平台中立，编辑内核等纯核心包以无 DOM/Node 类型的配置编译它。
 */
export function originOf(value: string): string | null {
  const match = /^(https?):\/\/(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?(?:[/?#].*)?$/i.exec(value.trim());
  if (match === null) return null;
  const scheme = match[1]!.toLowerCase();
  const host = match[2]!.toLowerCase();
  const port = match[3];
  const defaultPort = scheme === 'https' ? '443' : '80';
  return port === undefined || port === defaultPort ? `${scheme}://${host}` : `${scheme}://${host}:${port}`;
}

/** 数据库连接池（API、Worker、实时网关与命令行共用；缺省：5 个连接、不设超时）。 */
export const dbPoolEnvShape = {
  ANCS_DB_POOL_MAX: z.coerce.number().int().min(1, 'ANCS_DB_POOL_MAX ≥ 1').max(200, 'ANCS_DB_POOL_MAX ≤ 200').optional(),
  ANCS_DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100, 'ANCS_DB_CONNECT_TIMEOUT_MS ≥ 100').max(120_000, 'ANCS_DB_CONNECT_TIMEOUT_MS ≤ 120000').optional(),
  ANCS_DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1000, 'ANCS_DB_STATEMENT_TIMEOUT_MS ≥ 1000').max(3_600_000, 'ANCS_DB_STATEMENT_TIMEOUT_MS ≤ 3600000').optional(),
} satisfies z.ZodRawShape;

/** API 与 Worker 共用的基础连接配置。 */
export const baseEnvShape = {
  DATABASE_URL: nonEmpty('DATABASE_URL（PostgreSQL 连接串）'),
  ...dbPoolEnvShape,
  BETTER_AUTH_SECRET: z.string().min(16, 'BETTER_AUTH_SECRET 未配置或过短（≥16 字符；经 KMS/Secrets 注入，禁止入库）'),
} satisfies z.ZodRawShape;

/**
 * S3 兼容对象存储（`ANCS_STORAGE_DRIVER=s3`：AWS S3 / Cloudflare R2 / 阿里云 OSS / SeaweedFS 等）。
 * API、Worker、清理 CLI 必须指向同一个桶；浏览器经预签名 URL 直传直下（桶需配置允许你域名 PUT/GET 的 CORS）。
 * 访问密钥两项要么都配，要么都不配（都不配时用运行环境的凭据链，如云主机角色）。
 */
export const s3StorageEnvShape = {
  ANCS_S3_BUCKET: nonEmpty('ANCS_S3_BUCKET').optional(),
  /** 区域（AWS 如 us-east-1；R2 写 auto） */
  ANCS_S3_REGION: nonEmpty('ANCS_S3_REGION').optional(),
  /** 非 AWS 的服务端点（R2：https://<账号>.r2.cloudflarestorage.com；OSS：https://oss-cn-hangzhou.aliyuncs.com） */
  ANCS_S3_ENDPOINT: z.string().url('ANCS_S3_ENDPOINT 必须是完整 URL').optional(),
  /** 浏览器使用的端点（内网端点与公网地址不同时；缺省同 ANCS_S3_ENDPOINT） */
  ANCS_S3_PUBLIC_ENDPOINT: z.string().url('ANCS_S3_PUBLIC_ENDPOINT 必须是完整 URL').optional(),
  /** 路径风格寻址（自建 SeaweedFS 等通常需要 1） */
  ANCS_S3_FORCE_PATH_STYLE: z.enum(['0', '1'], { message: 'ANCS_S3_FORCE_PATH_STYLE 仅支持 0 | 1' }).optional(),
  ANCS_S3_ACCESS_KEY_ID: nonEmpty('ANCS_S3_ACCESS_KEY_ID').optional(),
  ANCS_S3_SECRET_ACCESS_KEY: nonEmpty('ANCS_S3_SECRET_ACCESS_KEY').optional(),
  /** 桶内前缀（多个环境共用一个桶时区分；如 prod/） */
  ANCS_S3_KEY_PREFIX: z
    .string()
    .regex(/^[A-Za-z0-9._\-/]*$/, 'ANCS_S3_KEY_PREFIX 仅允许字母、数字、._-/')
    .refine((value) => !value.startsWith('/') && !value.split('/').includes('..'), 'ANCS_S3_KEY_PREFIX 不得以 / 开头或包含 ..')
    .optional(),
} satisfies z.ZodRawShape;

/**
 * 发信（D-04：注册验证、找回密码、邀请邮件；API 与邀请 CLI 共用）。
 * - `smtp`：真实投递（AWS SES、Postmark、Resend、SendGrid、Mailgun 等都提供 SMTP），生产用；
 * - `log`：只在开发环境把邮件打到控制台（正文含一次性链接，生产禁用）；
 * - 不配：不发信——不能注册（ANCS_SIGNUP_MODE 只能 closed），也不能找回密码。
 */
export const emailEnvShape = {
  ANCS_EMAIL_DRIVER: z.enum(['log', 'smtp'], { message: 'ANCS_EMAIL_DRIVER 只能是 log 或 smtp' }).optional(),
  /** smtp(s)://用户名:密码@主机:端口（含密码，属于 Secret；465 端口用 smtps://） */
  ANCS_SMTP_URL: z.string().regex(/^smtps?:\/\/[^\s]+$/, 'ANCS_SMTP_URL 必须是 smtp:// 或 smtps:// 地址').optional(),
  /** 发件人，如 "ANCS <no-reply@example.com>"（域名需在发信服务商处完成 SPF / DKIM 验证） */
  ANCS_EMAIL_FROM: z.string().trim().min(3).max(200).refine((value) => /@[^\s@>]+\.[^\s@>]+/.test(value), 'ANCS_EMAIL_FROM 必须包含发件邮箱地址').optional(),
  /** 邮件里链接指向的网站地址（缺省 BETTER_AUTH_URL；网站与 API 不同域时配置） */
  ANCS_PUBLIC_WEB_URL: z.string().url('ANCS_PUBLIC_WEB_URL 必须是完整 URL').optional(),
  /** 邮件里显示的产品名（品牌未定前为 ANCS） */
  ANCS_PRODUCT_NAME: z.string().trim().min(1).max(60).default('ANCS'),
} satisfies z.ZodRawShape;

/** 发信配置的跨字段规则（API 与邀请 CLI 共用）。 */
export function crossCheckEmailEnv(value: {
  NODE_ENV?: 'development' | 'test' | 'production' | undefined;
  BETTER_AUTH_URL?: string | undefined;
  ANCS_EMAIL_DRIVER?: 'log' | 'smtp' | undefined;
  ANCS_SMTP_URL?: string | undefined;
  ANCS_EMAIL_FROM?: string | undefined;
  ANCS_PUBLIC_WEB_URL?: string | undefined;
}): EnvIssue[] {
  const issues: EnvIssue[] = [];
  if (value.ANCS_EMAIL_DRIVER === 'smtp') {
    if (value.ANCS_SMTP_URL === undefined) issues.push({ variable: 'ANCS_SMTP_URL', message: 'ANCS_EMAIL_DRIVER=smtp 时必须配置 SMTP 地址' });
    if (value.ANCS_EMAIL_FROM === undefined) issues.push({ variable: 'ANCS_EMAIL_FROM', message: 'ANCS_EMAIL_DRIVER=smtp 时必须配置发件人' });
  } else if (value.ANCS_SMTP_URL !== undefined) {
    issues.push({ variable: 'ANCS_EMAIL_DRIVER', message: '配置了 ANCS_SMTP_URL 却没有设 ANCS_EMAIL_DRIVER=smtp——发信配置不会静默生效，请补上驱动' });
  }
  if (value.ANCS_EMAIL_DRIVER === 'log' && value.NODE_ENV === 'production') {
    issues.push({ variable: 'ANCS_EMAIL_DRIVER', message: '生产环境不得使用 log 发信驱动（邮件里的一次性链接会进日志）；请用 smtp' });
  }
  if (value.ANCS_EMAIL_DRIVER !== undefined && value.NODE_ENV === 'production') {
    const linkBase = value.ANCS_PUBLIC_WEB_URL ?? value.BETTER_AUTH_URL;
    if (linkBase === undefined || !linkBase.startsWith('https://')) {
      issues.push({ variable: 'ANCS_PUBLIC_WEB_URL', message: '生产环境邮件链接必须指向 https 网站（配置 ANCS_PUBLIC_WEB_URL，或 https 的 BETTER_AUTH_URL）' });
    }
  }
  return issues;
}

/**
 * 每个工作区每月 AI 模型费用的部署缺省上限（美元）：套餐设了 aiSpendMicrosPerMonth 时以套餐为准。
 * API（新的一轮开始前）与 Worker（每次模型调用前）都要读到同一个值。
 * 生产必须显式配置：写金额（如 20 或 12.50）；确实不设上限写 unlimited。
 */
export const aiSpendEnvShape = {
  ANCS_AI_MONTHLY_CAP_USD: z.string().trim()
    .regex(/^(unlimited|\d{1,7}(\.\d{1,2})?)$/, 'ANCS_AI_MONTHLY_CAP_USD 必须是美元金额（如 20 或 12.50）或 unlimited').optional(),
} satisfies z.ZodRawShape;

/** 已校验的 ANCS_AI_MONTHLY_CAP_USD → 微美元；未配置或 unlimited → null（不设部署缺省上限）。 */
export function resolveAiMonthlyCapMicros(value: string | undefined): number | null {
  if (value === undefined || value === 'unlimited') return null;
  const [whole = '0', cents = ''] = value.split('.');
  return Number(whole) * 1_000_000 + Number(cents.padEnd(2, '0')) * 10_000;
}

export function crossCheckAiSpendEnv(value: { NODE_ENV?: 'development' | 'test' | 'production' | undefined; ANCS_AI_MONTHLY_CAP_USD?: string | undefined }): EnvIssue[] {
  if (value.NODE_ENV === 'production' && value.ANCS_AI_MONTHLY_CAP_USD === undefined) {
    return [{ variable: 'ANCS_AI_MONTHLY_CAP_USD', message: '生产环境必须显式配置每个工作区每月 AI 费用上限（美元，如 20）；确实不设上限写 unlimited' }];
  }
  return [];
}

const storageDriverSchema = z.enum(['local', 's3'], { message: 'ANCS_STORAGE_DRIVER 只能是 local 或 s3' }).default('local');

export type S3StorageEnv = { [K in keyof typeof s3StorageEnvShape]?: string | undefined };

/** 存储驱动的跨字段规则（API、Worker、清理 CLI 共用）。 */
export function crossCheckStorageEnv(value: { ANCS_STORAGE_DRIVER: 'local' | 's3' } & S3StorageEnv): EnvIssue[] {
  if (value.ANCS_STORAGE_DRIVER !== 's3') return [];
  const issues: EnvIssue[] = [];
  if (value.ANCS_S3_BUCKET === undefined) issues.push({ variable: 'ANCS_S3_BUCKET', message: 'ANCS_STORAGE_DRIVER=s3 时必须配置桶名' });
  if (value.ANCS_S3_REGION === undefined) issues.push({ variable: 'ANCS_S3_REGION', message: 'ANCS_STORAGE_DRIVER=s3 时必须配置区域（R2 写 auto）' });
  if ((value.ANCS_S3_ACCESS_KEY_ID === undefined) !== (value.ANCS_S3_SECRET_ACCESS_KEY === undefined)) {
    const pair = [['ANCS_S3_ACCESS_KEY_ID', value.ANCS_S3_ACCESS_KEY_ID], ['ANCS_S3_SECRET_ACCESS_KEY', value.ANCS_S3_SECRET_ACCESS_KEY]] as const;
    const missingHalf = pair.find(([, configured]) => configured === undefined)![0];
    issues.push({ variable: missingHalf, message: '访问密钥两项要么都配，要么都不配（都不配时用运行环境的凭据链）' });
  }
  if (value.ANCS_S3_PUBLIC_ENDPOINT !== undefined && value.ANCS_S3_ENDPOINT === undefined) {
    issues.push({ variable: 'ANCS_S3_PUBLIC_ENDPOINT', message: '只有配置了 ANCS_S3_ENDPOINT 时才需要单独的浏览器端点' });
  }
  return issues;
}

/** API 服务环境（apps/api）。 */
export const apiEnvSchema = z.object({
  ...baseEnvShape,
  NODE_ENV: z.enum(['development', 'test', 'production']).optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  /**
   * 供应商凭据信封加密密钥（`v1:<base64 32B>[,v2:...]`）。
   * **生产环境必填**：一个密钥泄露不应同时打穿会话、签名 URL 与供应商凭据；
   * 非生产可省略（由 BETTER_AUTH_SECRET 派生兜底并告警，见 credential-vault-local）。
   */
  ANCS_CREDENTIAL_KEYS: z.string().min(1, 'ANCS_CREDENTIAL_KEYS 不能为空字符串（格式 v1:<base64 32B>）').optional(),
  BETTER_AUTH_URL: z.string().url('BETTER_AUTH_URL 必须是完整 URL（如 https://api.example.com）').optional(),
  /** 存储驱动：local（单机磁盘，经 API 端点转发字节）| s3（S3 兼容对象存储，浏览器预签名直传；见 s3StorageEnvShape） */
  ANCS_STORAGE_DRIVER: storageDriverSchema,
  ANCS_STORAGE_SECRET: z.string().min(16, 'ANCS_STORAGE_SECRET 过短（≥16 字符）').optional(),
  ANCS_STORAGE_LOCAL_DIR: nonEmpty('ANCS_STORAGE_LOCAL_DIR').optional(),
  ANCS_STORAGE_PUBLIC_BASE_URL: z.string().url('ANCS_STORAGE_PUBLIC_BASE_URL 必须是完整 URL').optional(),
  ...s3StorageEnvShape,
  /**
   * 旧 V4 流水线（脚本 / 分镜 / 旧编辑器的叙事生成、旧配音、声音克隆、素材搜索、Mock 分发）：
   * mock = 装配测试替身（开发缺省）；off = 不装配，相关端点 501（**生产缺省**）。V6 共看片室、文章、自主制作不依赖它们。
   */
  ANCS_LEGACY_PIPELINE: z.enum(['mock', 'off'], { message: 'ANCS_LEGACY_PIPELINE 只能是 mock 或 off' }).optional(),
  /** LLM 驱动：V1 仅 mock（真实适配器需凭据 → 未实现驱动名明确失败） */
  ANCS_LLM_DRIVER: z.enum(['mock'], { message: 'ANCS_LLM_DRIVER 仅支持 mock（真实 LLM 适配器随凭据接入）' }).default('mock'),
  /** TTS 驱动：V1 仅 mock */
  ANCS_TTS_DRIVER: z.enum(['mock'], { message: 'ANCS_TTS_DRIVER 仅支持 mock（真实 TTS 适配器随凭据接入）' }).default('mock'),
  /** 原生客户端注册（JSON 数组；由 parseNativeClients 进一步校验） */
  ANCS_NATIVE_CLIENTS: z.string().optional(),
  /** Webhook 验签密钥（JSON；由 parseWebhookVerifiers 进一步校验） */
  ANCS_WEBHOOK_SECRETS: z.string().optional(),
  /**
   * 语音会话短期凭证签名密钥（N05-01）。未配置 → 创建语音会话 fail-closed（501），绝不回退长期 Key。
   * 与会话/存储/凭据密钥独立（一把泄露不打穿其他面）。
   */
  ANCS_VOICE_SESSION_SECRET: z.string().min(32, 'ANCS_VOICE_SESSION_SECRET 过短（≥32 字符）').optional(),
  /** 平台托管 Provider 凭据（`供应商:密钥,…`；仅后端使用，经凭据库登记） */
  ANCS_PLATFORM_PROVIDER_KEYS: z.string().optional(),
  /** 旧名：曾在 .env.example 中出现但从未被读取——配置了即启动失败并提示改名（不得静默忽略凭据配置） */
  PLATFORM_PROVIDER_KEYS: z.string().optional(),
  /** 历史兼容配置；N15-02 起不再授予运营权限。管理员身份由 admin_principals + role_grants 决定。 */
  ANCS_PLATFORM_ADMINS: z.string().optional(),
  ANCS_OPS_ENVIRONMENT: z.enum(['DEVELOPMENT', 'TEST', 'STAGING', 'PRODUCTION']).optional(),
  ANCS_OPS_IDLE_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  ANCS_OPS_ABSOLUTE_SECONDS: z.coerce.number().int().min(300).max(86400).default(28800),
  ANCS_OPS_REAUTH_SECONDS: z.coerce.number().int().min(30).max(1800).default(300),
  /** 未订阅 workspace 的默认套餐（P09-01；预上线默认 ENTERPRISE；**SaaS 上线门（P09-06）要求 FREE**） */
  ANCS_DEFAULT_PLAN: z.enum(['FREE', 'CREATOR', 'PRO', 'STUDIO', 'ENTERPRISE'], { message: 'ANCS_DEFAULT_PLAN 仅支持 FREE/CREATOR/PRO/STUDIO/ENTERPRISE' }).optional(),
  ...aiSpendEnvShape,
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
  /** 生产进程装配 MOCK/SCRIPTED 驱动的显式许可（V5-M3；缺省 = 不允许，见 checkProviderInventory） */
  ANCS_ALLOW_MOCK_PROVIDERS: z.enum(['0', '1'], { message: 'ANCS_ALLOW_MOCK_PROVIDERS 仅支持 0 | 1' }).optional(),
  /**
   * 允许的浏览器来源（逗号分隔的完整 origin；V5-M4 Edge）：CORS 白名单与带 Cookie 写请求的 Origin 校验。
   * 缺省 = BETTER_AUTH_URL 的 origin（非生产另加 http://localhost:3000、http://127.0.0.1:3000）。
   */
  ANCS_ALLOWED_ORIGINS: z.string().refine(
    (value) => value.split(',').map((item) => item.trim()).filter((item) => item !== '').every((item) => originOf(item) === item.replace(/\/+$/, '').toLowerCase()),
    'ANCS_ALLOWED_ORIGINS 必须是逗号分隔的完整 origin（如 https://app.example.com，不含路径）',
  ).optional(),
  /** 前置可信代理跳数（0 = 不信任 X-Forwarded-For；按 IP 限流依赖它取得真实客户端地址） */
  ANCS_TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5, 'ANCS_TRUST_PROXY_HOPS ≤ 5').default(0),
  /**
   * 优雅退出（生产部署）：收到 SIGTERM 后先标记"排空"（/ready 返回 503）并等待这么多秒让负载均衡摘掉实例，
   * 再停止接新连接、等进行中的请求处理完；超过 ANCS_SHUTDOWN_TIMEOUT_SECONDS 强制退出。
   */
  ANCS_SHUTDOWN_DRAIN_SECONDS: z.coerce.number().int().min(0).max(120).default(0),
  ANCS_SHUTDOWN_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(600).default(25),
  /** 限流开关（生产不得关闭） */
  ANCS_RATE_LIMIT: z.enum(['enforce', 'off'], { message: 'ANCS_RATE_LIMIT 仅支持 enforce | off' }).default('enforce'),
  /** 共享限流（多台 API 共用额度）：Redis 地址；不配则每个 API 进程各自限流 */
  ANCS_RATE_LIMIT_REDIS_URL: z.string().regex(/^rediss?:\/\//, 'ANCS_RATE_LIMIT_REDIS_URL 必须是 redis:// 或 rediss:// 地址').optional(),
  /**
   * 注册方式（D-04）：closed = 只能由运营建账号（缺省）；invite = 只有收到邀请（平台邀请或工作区邀请）的邮箱能注册；
   * open = 任何人。invite / open 需要发信（ANCS_EMAIL_DRIVER）。所有者决定首轮内测上线用 invite。
   */
  ANCS_SIGNUP_MODE: z.enum(['closed', 'invite', 'open'], { message: 'ANCS_SIGNUP_MODE 只能是 closed、invite 或 open' }).default('closed'),
  ...emailEnvShape,
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;

/** 跨字段规则（API；schema 之外的可读校验；返回全部问题）。 */
export function crossCheckApiEnv(value: ApiEnv): EnvIssue[] {
  const issues: EnvIssue[] = [...crossCheckStorageEnv(value), ...crossCheckEmailEnv(value), ...crossCheckAiSpendEnv(value)];
  if (value.ANCS_SIGNUP_MODE !== 'closed' && value.ANCS_EMAIL_DRIVER === undefined) {
    issues.push({ variable: 'ANCS_SIGNUP_MODE', message: `ANCS_SIGNUP_MODE=${value.ANCS_SIGNUP_MODE} 需要发信（注册要发验证邮件）：请配置 ANCS_EMAIL_DRIVER` });
  }
  if (value.PLATFORM_PROVIDER_KEYS !== undefined && value.PLATFORM_PROVIDER_KEYS.trim() !== '') {
    issues.push({ variable: 'PLATFORM_PROVIDER_KEYS', message: '该变量名从未生效，已统一为 ANCS_PLATFORM_PROVIDER_KEYS（格式 供应商:密钥,…）——请改名后重启' });
  }
  if (value.NODE_ENV === 'production' && value.ANCS_OPS_ENVIRONMENT !== 'PRODUCTION') {
    issues.push({ variable: 'ANCS_OPS_ENVIRONMENT', message: '生产进程必须显式配置 PRODUCTION 运营环境' });
  }
  if (value.NODE_ENV !== 'production' && value.ANCS_OPS_ENVIRONMENT === 'PRODUCTION') {
    issues.push({ variable: 'ANCS_OPS_ENVIRONMENT', message: '非生产进程不得签发 PRODUCTION 运营会话' });
  }
  // 生产必须显式配置凭据信封密钥：避免"一把会话密钥同时管会话/签名 URL/供应商凭据"。
  if (value.NODE_ENV === 'production' && (value.ANCS_CREDENTIAL_KEYS ?? '').trim() === '') {
    issues.push({
      variable: 'ANCS_CREDENTIAL_KEYS',
      message: '生产环境必须显式配置 ANCS_CREDENTIAL_KEYS（v1:<base64 32B>）——不得从 BETTER_AUTH_SECRET 派生',
    });
  }
  if (value.NODE_ENV === 'production' && value.ANCS_RATE_LIMIT === 'off') {
    issues.push({ variable: 'ANCS_RATE_LIMIT', message: '生产环境不得关闭限流' });
  }
  if (value.NODE_ENV === 'production' && value.ANCS_STORAGE_DRIVER === 'local' && value.ANCS_STORAGE_SECRET === undefined) {
    issues.push({
      variable: 'ANCS_STORAGE_SECRET',
      message: '生产环境必须显式配置 ANCS_STORAGE_SECRET（≥16）——签名 URL 不得从 BETTER_AUTH_SECRET 派生',
    });
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
        message: 'live 模式不得使用 local 存储（单机磁盘无法多机扩容；设 ANCS_STORAGE_DRIVER=s3）',
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
  NODE_ENV: z.enum(['development', 'test', 'production']).optional(),
  /** 存储签名 URL 的公开基址回退（与 API 同一规则：ANCS_STORAGE_PUBLIC_BASE_URL → BETTER_AUTH_URL → localhost） */
  BETTER_AUTH_URL: z.string().url('BETTER_AUTH_URL 必须是完整 URL').optional(),
  ANCS_DEFAULT_PLAN: z.enum(['FREE', 'CREATOR', 'PRO', 'STUDIO', 'ENTERPRISE'], { message: 'ANCS_DEFAULT_PLAN 仅支持 FREE/CREATOR/PRO/STUDIO/ENTERPRISE' }).optional(),
  ...aiSpendEnvShape,
  ANCS_WORKER_ID: nonEmpty('ANCS_WORKER_ID').optional(),
  ANCS_WORKER_TICK_MS: z.coerce.number().int().min(50, 'ANCS_WORKER_TICK_MS ≥ 50').max(60_000, 'ANCS_WORKER_TICK_MS ≤ 60000').default(1000),
  ANCS_WORKER_LEASE_SECONDS: z.coerce.number().int().min(5, 'ANCS_WORKER_LEASE_SECONDS ≥ 5').max(3600, 'ANCS_WORKER_LEASE_SECONDS ≤ 3600').default(60),
  ANCS_WORKER_HEARTBEAT_MS: z.coerce.number().int().min(100, 'ANCS_WORKER_HEARTBEAT_MS ≥ 100').optional(),
  /** 故障注入（P03-02 演练）：在关键阶段退出进程 */
  ANCS_WORKER_CRASH_AT: z.string().optional(),
  ANCS_FFMPEG_PATH: nonEmpty('ANCS_FFMPEG_PATH').optional(),
  ANCS_FFPROBE_PATH: nonEmpty('ANCS_FFPROBE_PATH').optional(),
  /** 生产进程装配 MOCK/SCRIPTED 驱动的显式许可（V5-M3） */
  ANCS_ALLOW_MOCK_PROVIDERS: z.enum(['0', '1'], { message: 'ANCS_ALLOW_MOCK_PROVIDERS 仅支持 0 | 1' }).optional(),
  /** 与 API 同一把凭据信封密钥（Worker 解密 BYOK 凭据调用 Provider）；生产必填 */
  ANCS_CREDENTIAL_KEYS: z.string().min(1, 'ANCS_CREDENTIAL_KEYS 不能为空字符串（格式 v1:<base64 32B>）').optional(),
  /** 队列驱动：db（默认，权威状态轮询）| bullmq（需 REDIS_URL） */
  ANCS_QUEUE_DRIVER: z.enum(['db', 'bullmq'], { message: 'ANCS_QUEUE_DRIVER 仅支持 db | bullmq' }).default('db'),
  REDIS_URL: z.string().url('REDIS_URL 必须是完整 URL（如 redis://localhost:6379）').optional(),
  /**
   * AI 生成合成内容标识（GB 45438-2025 附录 E）：生成合成服务提供者编码，写进导出文件 AIGC 元数据的
   * ContentProducer / ContentPropagator。面向中国境内公众提供服务时必须配置（运营方的统一社会信用代码等，见手册）。
   */
  ANCS_AIGC_PRODUCER_CODE: z.string().regex(/^[0-9A-Za-z_-]{1,64}$/, 'ANCS_AIGC_PRODUCER_CODE 只能是 1–64 位字母、数字、_ 或 -').optional(),
  /** 与 API 相同的存储驱动与桶（同一份对象） */
  ANCS_STORAGE_DRIVER: storageDriverSchema,
  ANCS_STORAGE_SECRET: z.string().min(16, 'ANCS_STORAGE_SECRET 过短（≥16 字符）').optional(),
  ANCS_STORAGE_LOCAL_DIR: nonEmpty('ANCS_STORAGE_LOCAL_DIR').optional(),
  ANCS_STORAGE_PUBLIC_BASE_URL: z.string().url('ANCS_STORAGE_PUBLIC_BASE_URL 必须是完整 URL').optional(),
  ...s3StorageEnvShape,
  REMOTION_BROWSER_EXECUTABLE: nonEmpty('REMOTION_BROWSER_EXECUTABLE').optional(),
  ANCS_RENDER_EXECUTOR_CMD: nonEmpty('ANCS_RENDER_EXECUTOR_CMD').optional(),
  ANCS_MOTION_VALIDATOR_CMD: nonEmpty('ANCS_MOTION_VALIDATOR_CMD').optional(),
  ANCS_MEDIA_PROBE_CMD: nonEmpty('ANCS_MEDIA_PROBE_CMD').optional(),
  /**
   * ASR 驱动（V5-M3）：process = 运维配置的子进程（ANCS_ASR_EXECUTABLE）；deepgram = 真实 Deepgram（需 DEEPGRAM_API_KEY）。
   * 缺省：配置了 ANCS_ASR_EXECUTABLE 则为 process，否则不装配（转写任务明确失败"ASR 未配置"）。
   */
  ANCS_ASR_DRIVER: z.enum(['process', 'deepgram'], { message: 'ANCS_ASR_DRIVER 仅支持 process | deepgram' }).optional(),
  /** Deepgram API Key（只在 Worker 进程内存中使用；绝不写日志、不进错误返回） */
  DEEPGRAM_API_KEY: z.string().min(16, 'DEEPGRAM_API_KEY 过短').optional(),
  ANCS_DEEPGRAM_MODEL: nonEmpty('ANCS_DEEPGRAM_MODEL').optional(),
  ANCS_DEEPGRAM_LANGUAGE: z.string().min(2).max(35, 'ANCS_DEEPGRAM_LANGUAGE 过长').optional(),
  /** ASR 子进程协议：最后一个参数为源文件路径，stdout 返回 GeneratedMediaTranscript JSON。 */
  ANCS_ASR_EXECUTABLE: nonEmpty('ANCS_ASR_EXECUTABLE').optional(),
  ANCS_ASR_ARGS_JSON: z.string().refine((value) => { try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string'); } catch { return false; } }, 'ANCS_ASR_ARGS_JSON 必须是字符串数组 JSON').optional(),
  /**
   * 视觉分析驱动（V6-1b）：process = 运维配置的子进程；anthropic / gemini = 视觉模型逐帧写镜头说明（需对应密钥）。
   * 缺省：配置了 ANCS_VISUAL_ANALYSIS_EXECUTABLE 则为 process，否则不装配（视觉分析任务明确失败"未配置"）。
   */
  ANCS_VISUAL_ANALYSIS_DRIVER: z.enum(['process', 'anthropic', 'gemini'], { message: 'ANCS_VISUAL_ANALYSIS_DRIVER 仅支持 process | anthropic | gemini' }).optional(),
  /** 视觉理解模型 id（缺省 anthropic: claude-haiku-5-5；gemini: gemini-flash-lite-latest） */
  ANCS_VISION_MODEL: nonEmpty('ANCS_VISION_MODEL').optional(),
  /** 视觉分析子进程协议：最后一个参数为源文件路径，stdout 返回 GeneratedMediaVisualAnalysis JSON。 */
  ANCS_VISUAL_ANALYSIS_EXECUTABLE: nonEmpty('ANCS_VISUAL_ANALYSIS_EXECUTABLE').optional(),
  ANCS_VISUAL_ANALYSIS_ARGS_JSON: z.string().refine((value) => { try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string'); } catch { return false; } }, 'ANCS_VISUAL_ANALYSIS_ARGS_JSON 必须是字符串数组 JSON').optional(),
  /** 音频事件分析子进程协议：最后一个参数为源文件路径，stdout 返回 GeneratedMediaAudioAnalysis JSON。 */
  ANCS_AUDIO_ANALYSIS_EXECUTABLE: nonEmpty('ANCS_AUDIO_ANALYSIS_EXECUTABLE').optional(),
  ANCS_AUDIO_ANALYSIS_ARGS_JSON: z.string().refine((value) => { try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string'); } catch { return false; } }, 'ANCS_AUDIO_ANALYSIS_ARGS_JSON 必须是字符串数组 JSON').optional(),
  ANCS_DISABLE_RENDER: z.enum(['0', '1']).optional(),
  ANCS_WORKER_ONCE: z.enum(['0', '1']).optional(),
  /**
   * 通用导演 Agent 的模型驱动（V6-1）：anthropic = 真实 Claude（需 ANTHROPIC_API_KEY）；gemini = Google Gemini（需 GEMINI_API_KEY）。
   * 未配置时不装配真实模型：AI 轮次明确失败（AGENT_MODEL_NOT_CONFIGURED），不回退 Mock。风格撰写（蒸馏器）用同一个模型。
   */
  ANCS_AGENT_DRIVER: z.enum(['anthropic', 'gemini'], { message: 'ANCS_AGENT_DRIVER 仅支持 anthropic | gemini' }).optional(),
  /** Claude API Key（只在 Worker 进程内存中使用；绝不写日志、不进错误返回、不下发客户端） */
  ANTHROPIC_API_KEY: z.string().min(16, 'ANTHROPIC_API_KEY 过短').optional(),
  /**
   * Claude 走兼容 Anthropic Messages 协议的网关时的基址（如企业代理或模型聚合网关，填到 /v1 之前，例 https://gateway.example.com）。
   * 不填 = 直连 Anthropic。导演与视觉理解（driver=anthropic）都用它；密钥仍是 ANTHROPIC_API_KEY（填网关发的 Key）。
   */
  ANCS_ANTHROPIC_BASE_URL: z.string().url('ANCS_ANTHROPIC_BASE_URL 必须是完整 URL').refine((value) => value.startsWith('https://'), 'ANCS_ANTHROPIC_BASE_URL 必须是 https').optional(),
  /**
   * Google Gemini API Key（https://ai.google.dev）：导演 / 视觉理解（driver=gemini）、讲述配音（ANCS_NARRATION_DRIVER=gemini）、
   * Veo 生成镜头（ANCS_VEO_OFFER_JSON）。只在 Worker 进程内存中使用，只放请求头。
   */
  GEMINI_API_KEY: z.string().min(16, 'GEMINI_API_KEY 过短').optional(),
  /** 导演模型 id（缺省 anthropic: claude-opus-5-5；gemini: gemini-flash-latest） */
  ANCS_AGENT_MODEL: nonEmpty('ANCS_AGENT_MODEL').optional(),
  /**
   * V6-3：AI 当场写特效代码（缺省 disabled = 只用模板库）。部署方按评测结果开启；开启后代码仍须过四道门禁才渲染。
   */
  ANCS_EFFECT_CODEGEN: z.enum(['disabled', 'enabled'], { message: 'ANCS_EFFECT_CODEGEN 仅支持 disabled / enabled' }).optional(),
  /** 特效图层渲染命令覆盖（缺省：仓库内 apps/render-worker/src/run-effect.ts） */
  ANCS_EFFECT_RENDER_CMD: nonEmpty('ANCS_EFFECT_RENDER_CMD').optional(),
  /**
   * V6-6 蒸馏器：平台链接（YouTube、B 站……）的下载命令，占位符 {url} {output}，例如 `yt-dlp -f mp4/best -o {output} {url}`。
   * 不配置时平台链接明确失败并提示改为上传文件；直接的视频文件链接不需要它。版权由项目所有者负责。
   */
  ANCS_REFERENCE_FETCH_CMD: nonEmpty('ANCS_REFERENCE_FETCH_CMD').refine((value) => value.includes('{url}') && value.includes('{output}'), 'ANCS_REFERENCE_FETCH_CMD 必须包含 {url} 与 {output} 占位符').optional(),
  /** 参考视频大小上限（MB，缺省 1024） */
  ANCS_REFERENCE_MAX_MB: z.coerce.number().int().min(1).max(8192).optional(),
  /**
   * V6-5 讲述配音（AI 合成讲述音频）：flite = FFmpeg 内置的本地英文语音（无需密钥、音质基础，FFmpeg 需带 libflite）；
   * process = 部署方接入的语音合成子进程（任意供应商；协议：stdin 一行 JSON {text, voice, speed}，stdout 输出 FFmpeg 可解码的音频）。
   * 不配置时讲述工具明确报"本部署没有配置配音"。
   */
  ANCS_NARRATION_DRIVER: z.enum(['flite', 'process', 'fish', 'gemini'], { message: 'ANCS_NARRATION_DRIVER 仅支持 flite | process | fish | gemini' }).optional(),
  /** Gemini 语音合成模型（driver=gemini），缺省 gemini-3.8-flash-lite-tts；声音为 Gemini 预置声音（缺省列表见 Worker，可用 ANCS_NARRATION_VOICES_JSON 覆盖） */
  ANCS_GEMINI_TTS_MODEL: nonEmpty('ANCS_GEMINI_TTS_MODEL').optional(),
  /** Fish Audio（https://fish.audio）密钥：讲述配音（driver=fish）与数字人"你的声音"（声音克隆）。只在 Worker 内存中使用 */
  FISH_AUDIO_API_KEY: z.string().min(16, 'FISH_AUDIO_API_KEY 过短').optional(),
  /** Fish Audio TTS 模型（请求头 model），缺省 s1 */
  ANCS_FISH_AUDIO_MODEL: nonEmpty('ANCS_FISH_AUDIO_MODEL').optional(),
  ANCS_NARRATION_EXECUTABLE: nonEmpty('ANCS_NARRATION_EXECUTABLE').optional(),
  ANCS_NARRATION_ARGS_JSON: z.string().refine((value) => { try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string'); } catch { return false; } }, 'ANCS_NARRATION_ARGS_JSON 必须是字符串数组 JSON').optional(),
  /** process 驱动提供的声音列表（JSON 数组：{ id, name, languages: ["zh","en"], description }） */
  ANCS_NARRATION_VOICES_JSON: z.string().refine((value) => {
    try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) && parsed.length > 0 && parsed.every((item) => narrationVoiceSchema.safeParse(item).success); } catch { return false; }
  }, 'ANCS_NARRATION_VOICES_JSON 必须是声音数组 JSON：[{ "id": "zh-female-1", "name": "…", "languages": ["zh"], "description": "…" }]').optional(),
  /**
   * V6-7/V6-8 付费生成（数字人出镜、生成镜头、选区重绘）：process = 部署方接入的生成子进程（任意供应商；
   * 协议见 docs/V06/integration-checklist.md 与 scripts/generation-process-example.mjs）。不配置时报价工具明确报"本部署没有配置"。
   * 每次生成只调用一次（不自动重试）；结果不明 → 待对账。
   */
  ANCS_GENERATION_DRIVER: z.enum(['process'], { message: 'ANCS_GENERATION_DRIVER 仅支持 process' }).optional(),
  ANCS_GENERATION_EXECUTABLE: nonEmpty('ANCS_GENERATION_EXECUTABLE').optional(),
  ANCS_GENERATION_ARGS_JSON: z.string().refine((value) => { try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string'); } catch { return false; } }, 'ANCS_GENERATION_ARGS_JSON 必须是字符串数组 JSON').optional(),
  /** 供应商报价依据（JSON 数组：{ kind, providerId, implementation: "REAL", model, perSecondMicros: { min, max }, maxSeconds, languages }） */
  ANCS_GENERATION_OFFERS_JSON: z.string().refine((value) => {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) && parsed.length > 0 && parsed.every((item) => { const offer = generationOfferSchema.safeParse(item); return offer.success && offer.data.implementation === 'REAL'; });
    } catch { return false; }
  }, 'ANCS_GENERATION_OFFERS_JSON 必须是报价数组 JSON：[{ "kind": "VIDEO_SHOT", "providerId": "vendor-x", "implementation": "REAL", "model": "…", "perSecondMicros": { "min": 50000, "max": 400000 }, "maxSeconds": 8 }]').optional(),
  /** 传给生成子进程的额外环境变量名（逗号分隔，例如供应商密钥 VENDOR_API_KEY）；子进程只拿到白名单 + 这里列出的变量 */
  ANCS_GENERATION_PASS_ENV: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*$/, 'ANCS_GENERATION_PASS_ENV 必须是逗号分隔的环境变量名').optional(),
  /**
   * V6-7 数字人出镜：heygen = HeyGen 会说话的照片 + Fish Audio 用你的声音读讲稿（需 HEYGEN_API_KEY 与 FISH_AUDIO_API_KEY）。
   * 与 ANCS_GENERATION_DRIVER（生成镜头/选区重绘）可以并存。
   */
  ANCS_AVATAR_DRIVER: z.enum(['heygen'], { message: 'ANCS_AVATAR_DRIVER 仅支持 heygen' }).optional(),
  HEYGEN_API_KEY: z.string().min(16, 'HEYGEN_API_KEY 过短').optional(),
  /** 数字人报价依据覆盖（JSON：{ kind: "AVATAR_CLIP", providerId, implementation: "REAL", model, perSecondMicros, maxSeconds, languages }）；缺省为 V6 §10.1 规划区间 */
  ANCS_AVATAR_OFFER_JSON: z.string().refine((value) => {
    try { const offer = generationOfferSchema.safeParse(JSON.parse(value)); return offer.success && offer.data.kind === 'AVATAR_CLIP' && offer.data.implementation === 'REAL'; } catch { return false; }
  }, 'ANCS_AVATAR_OFFER_JSON 必须是 AVATAR_CLIP 的报价 JSON（implementation 为 REAL）').optional(),
  /**
   * V6-8 生成镜头接 Google Veo（需 GEMINI_API_KEY）：VIDEO_SHOT 的报价依据，model 为 Veo 模型 id（如 veo-3.1-fast-generate-preview），
   * durationOptions 为 Veo 能生成的时长档位（如 [4,6,8]，按不短于所需的最短一档计费）。价格按 Google 价格页填写，平台不内置。
   * 配置即启用；与 ANCS_GENERATION_DRIVER、ANCS_AVATAR_DRIVER 可以并存。
   */
  ANCS_VEO_OFFER_JSON: z.string().refine((value) => {
    try {
      const offer = generationOfferSchema.safeParse(JSON.parse(value));
      return offer.success && offer.data.kind === 'VIDEO_SHOT' && offer.data.implementation === 'REAL' && (offer.data.durationOptions?.length ?? 0) > 0;
    } catch { return false; }
  }, 'ANCS_VEO_OFFER_JSON 必须是 VIDEO_SHOT 的报价 JSON（implementation 为 REAL，带 durationOptions，例如 [4,6,8]）').optional(),
  /** 火山方舟（Volcengine Ark）API Key：Seedance 生成镜头（ANCS_SEEDANCE_OFFER_JSON）。只在 Worker 内存中使用，只放请求头 */
  ARK_API_KEY: z.string().min(16, 'ARK_API_KEY 过短').optional(),
  /** 方舟 API 地址（缺省 https://ark.cn-beijing.volces.com/api/v3） */
  ANCS_ARK_BASE_URL: z.string().url('ANCS_ARK_BASE_URL 必须是完整 URL').refine((value) => value.startsWith('https://'), 'ANCS_ARK_BASE_URL 必须是 https').optional(),
  /**
   * V6-8 生成镜头接火山方舟 Seedance（需 ARK_API_KEY）：VIDEO_SHOT 的报价依据，model 为 Seedance 模型 id（如 doubao-seedance-2-5-260628），
   * durationOptions 为整数秒档位（按不短于所需的最短一档计费）。价格按方舟价格页换算成美元微单位填写（方舟按 token 计价、人民币结算），平台不内置。
   * 配置即启用；与 Veo、进程驱动、数字人可以并存。
   */
  ANCS_SEEDANCE_OFFER_JSON: z.string().refine((value) => {
    try {
      const offer = generationOfferSchema.safeParse(JSON.parse(value));
      return offer.success && offer.data.kind === 'VIDEO_SHOT' && offer.data.implementation === 'REAL' && (offer.data.durationOptions?.length ?? 0) > 0;
    } catch { return false; }
  }, 'ANCS_SEEDANCE_OFFER_JSON 必须是 VIDEO_SHOT 的报价 JSON（implementation 为 REAL，带整数秒 durationOptions，例如 [5,10]）').optional(),
  /** Runway API Key（https://dev.runwayml.com）：选区重绘（ANCS_RUNWAY_OFFER_JSON）。只在 Worker 内存中使用，只放请求头 */
  RUNWAYML_API_SECRET: z.string().min(16, 'RUNWAYML_API_SECRET 过短').optional(),
  /** Runway API 地址（缺省 https://api.dev.runwayml.com/v1） */
  ANCS_RUNWAY_BASE_URL: z.string().url('ANCS_RUNWAY_BASE_URL 必须是完整 URL').refine((value) => value.startsWith('https://'), 'ANCS_RUNWAY_BASE_URL 必须是 https').optional(),
  /**
   * V6-8 选区重绘接 Runway gen4_aleph（需 RUNWAYML_API_SECRET）：VIDEO_REGION 的报价依据（model 为 Runway 模型 id，如 gen4_aleph）。
   * 价格按 Runway 价格页填写（按秒计费的 credits 换算成美元微单位），平台不内置。配置即启用；可与进程驱动并存。
   */
  ANCS_RUNWAY_OFFER_JSON: z.string().refine((value) => {
    try { const offer = generationOfferSchema.safeParse(JSON.parse(value)); return offer.success && offer.data.kind === 'VIDEO_REGION' && offer.data.implementation === 'REAL'; } catch { return false; }
  }, 'ANCS_RUNWAY_OFFER_JSON 必须是 VIDEO_REGION 的报价 JSON（implementation 为 REAL）').optional(),
  /** Seedance 是否同时生成声音（缺省 1） */
  ANCS_SEEDANCE_GENERATE_AUDIO: z.enum(['0', '1'], { message: 'ANCS_SEEDANCE_GENERATE_AUDIO 仅支持 0 | 1' }).optional(),
  /** Seedance 分辨率（如 480p / 720p / 1080p；缺省用模型的缺省值） */
  ANCS_SEEDANCE_RESOLUTION: z.string().regex(/^\d{3,4}p$/, 'ANCS_SEEDANCE_RESOLUTION 形如 720p').optional(),
  /** 单次生成子进程超时（秒，缺省 1200）；超时按"结果不明"处理（待对账，不重试） */
  ANCS_GENERATION_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(7200).optional(),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/** 跨字段规则（schema 之外的可读校验；返回全部问题）。 */
export function crossCheckWorkerEnv(value: WorkerEnv): EnvIssue[] {
  const issues: EnvIssue[] = [...crossCheckStorageEnv(value), ...crossCheckAiSpendEnv(value)];
  if (value.ANCS_QUEUE_DRIVER === 'bullmq' && value.REDIS_URL === undefined) {
    issues.push({ variable: 'REDIS_URL', message: 'ANCS_QUEUE_DRIVER=bullmq 时必须配置 REDIS_URL' });
  }
  if (value.NODE_ENV === 'production' && value.ANCS_STORAGE_DRIVER === 'local' && value.ANCS_STORAGE_SECRET === undefined) {
    issues.push({
      variable: 'ANCS_STORAGE_SECRET',
      message: '生产环境必须显式配置 ANCS_STORAGE_SECRET（≥16）——与 API 同一把签名密钥，不得从 BETTER_AUTH_SECRET 派生',
    });
  }
  if (value.NODE_ENV === 'production' && (value.ANCS_CREDENTIAL_KEYS ?? '').trim() === '') {
    issues.push({ variable: 'ANCS_CREDENTIAL_KEYS', message: '生产环境必须显式配置 ANCS_CREDENTIAL_KEYS（与 API 相同）——不得从 BETTER_AUTH_SECRET 派生' });
  }
  if (value.ANCS_ASR_DRIVER === 'deepgram' && value.DEEPGRAM_API_KEY === undefined) {
    issues.push({ variable: 'DEEPGRAM_API_KEY', message: 'ANCS_ASR_DRIVER=deepgram 时必须配置 DEEPGRAM_API_KEY（fail-closed，不回退 Mock）' });
  }
  if (value.ANCS_VISUAL_ANALYSIS_DRIVER === 'anthropic' && value.ANTHROPIC_API_KEY === undefined) {
    issues.push({ variable: 'ANTHROPIC_API_KEY', message: 'ANCS_VISUAL_ANALYSIS_DRIVER=anthropic 时必须配置 ANTHROPIC_API_KEY（fail-closed，不回退 Mock）' });
  }
  if (value.ANCS_VISUAL_ANALYSIS_DRIVER === 'process' && value.ANCS_VISUAL_ANALYSIS_EXECUTABLE === undefined) {
    issues.push({ variable: 'ANCS_VISUAL_ANALYSIS_EXECUTABLE', message: 'ANCS_VISUAL_ANALYSIS_DRIVER=process 时必须配置 ANCS_VISUAL_ANALYSIS_EXECUTABLE' });
  }
  for (const [variable, driver] of [['ANCS_AGENT_DRIVER', value.ANCS_AGENT_DRIVER], ['ANCS_VISUAL_ANALYSIS_DRIVER', value.ANCS_VISUAL_ANALYSIS_DRIVER], ['ANCS_NARRATION_DRIVER', value.ANCS_NARRATION_DRIVER]] as const) {
    if (driver === 'gemini' && value.GEMINI_API_KEY === undefined) {
      issues.push({ variable: 'GEMINI_API_KEY', message: `${variable}=gemini 时必须配置 GEMINI_API_KEY（fail-closed，不回退 Mock）` });
    }
  }
  if (value.ANCS_RUNWAY_OFFER_JSON !== undefined && value.RUNWAYML_API_SECRET === undefined) {
    issues.push({ variable: 'RUNWAYML_API_SECRET', message: '配置了 ANCS_RUNWAY_OFFER_JSON（Runway 选区重绘）时必须配置 RUNWAYML_API_SECRET' });
  }
  if (value.ANCS_SEEDANCE_OFFER_JSON !== undefined && value.ARK_API_KEY === undefined) {
    issues.push({ variable: 'ARK_API_KEY', message: '配置了 ANCS_SEEDANCE_OFFER_JSON（Seedance 生成镜头）时必须配置 ARK_API_KEY' });
  }
  if (value.ANCS_VEO_OFFER_JSON !== undefined && value.GEMINI_API_KEY === undefined) {
    issues.push({ variable: 'GEMINI_API_KEY', message: '配置了 ANCS_VEO_OFFER_JSON（Veo 生成镜头）时必须配置 GEMINI_API_KEY' });
  }
  if (value.ANCS_AGENT_DRIVER === 'anthropic' && value.ANTHROPIC_API_KEY === undefined) {
    issues.push({ variable: 'ANTHROPIC_API_KEY', message: 'ANCS_AGENT_DRIVER=anthropic 时必须配置 ANTHROPIC_API_KEY（fail-closed，不回退 Mock）' });
  }
  if (value.ANCS_ASR_DRIVER === 'process' && value.ANCS_ASR_EXECUTABLE === undefined) {
    issues.push({ variable: 'ANCS_ASR_EXECUTABLE', message: 'ANCS_ASR_DRIVER=process 时必须配置 ANCS_ASR_EXECUTABLE' });
  }
  if (value.ANCS_NARRATION_DRIVER === 'process' && value.ANCS_NARRATION_EXECUTABLE === undefined) {
    issues.push({ variable: 'ANCS_NARRATION_EXECUTABLE', message: 'ANCS_NARRATION_DRIVER=process 时必须配置 ANCS_NARRATION_EXECUTABLE' });
  }
  if (value.ANCS_NARRATION_DRIVER === 'process' && value.ANCS_NARRATION_VOICES_JSON === undefined) {
    issues.push({ variable: 'ANCS_NARRATION_VOICES_JSON', message: 'ANCS_NARRATION_DRIVER=process 时必须用 ANCS_NARRATION_VOICES_JSON 声明可用的声音与语言' });
  }
  if (value.ANCS_NARRATION_DRIVER === 'fish' && value.FISH_AUDIO_API_KEY === undefined) {
    issues.push({ variable: 'FISH_AUDIO_API_KEY', message: 'ANCS_NARRATION_DRIVER=fish 时必须配置 FISH_AUDIO_API_KEY（fail-closed，不回退 Mock）' });
  }
  if (value.ANCS_NARRATION_DRIVER === 'fish' && value.ANCS_NARRATION_VOICES_JSON === undefined) {
    issues.push({ variable: 'ANCS_NARRATION_VOICES_JSON', message: 'ANCS_NARRATION_DRIVER=fish 时必须用 ANCS_NARRATION_VOICES_JSON 声明 Fish Audio 声音（id = Fish 声音模型 id）与语言' });
  }
  if (value.ANCS_AVATAR_DRIVER === 'heygen' && value.HEYGEN_API_KEY === undefined) {
    issues.push({ variable: 'HEYGEN_API_KEY', message: 'ANCS_AVATAR_DRIVER=heygen 时必须配置 HEYGEN_API_KEY（fail-closed）' });
  }
  if (value.ANCS_AVATAR_DRIVER === 'heygen' && value.FISH_AUDIO_API_KEY === undefined) {
    issues.push({ variable: 'FISH_AUDIO_API_KEY', message: 'ANCS_AVATAR_DRIVER=heygen 用 Fish Audio 合成"你的声音"，必须配置 FISH_AUDIO_API_KEY' });
  }
  if (value.ANCS_GENERATION_DRIVER === 'process' && value.ANCS_GENERATION_EXECUTABLE === undefined) {
    issues.push({ variable: 'ANCS_GENERATION_EXECUTABLE', message: 'ANCS_GENERATION_DRIVER=process 时必须配置 ANCS_GENERATION_EXECUTABLE' });
  }
  if (value.ANCS_GENERATION_DRIVER === 'process' && value.ANCS_GENERATION_OFFERS_JSON === undefined) {
    issues.push({ variable: 'ANCS_GENERATION_OFFERS_JSON', message: 'ANCS_GENERATION_DRIVER=process 时必须用 ANCS_GENERATION_OFFERS_JSON 声明支持的生成类型与价格（报价依据）' });
  }
  if (value.ANCS_WORKER_HEARTBEAT_MS !== undefined && value.ANCS_WORKER_HEARTBEAT_MS >= value.ANCS_WORKER_LEASE_SECONDS * 1000) {
    issues.push({ variable: 'ANCS_WORKER_HEARTBEAT_MS', message: '心跳间隔必须小于租约时长（否则租约会在两次心跳之间过期）' });
  }
  return issues;
}

/** 保留清理 CLI 环境（apps/api retention:sweep）：与 API 同一存储签名规则。 */
/** 建首个账号（部署后一次性运行；公开注册上线前的唯一建号方式）。密码只从环境变量读，不经命令行参数（会进 shell 历史与进程列表）。 */
export const createUserCliEnvSchema = z.object({
  ...baseEnvShape,
  BETTER_AUTH_URL: z.string().url('BETTER_AUTH_URL 必须是完整 URL').optional(),
  ANCS_NEW_USER_EMAIL: z.string().email('ANCS_NEW_USER_EMAIL 必须是邮箱'),
  ANCS_NEW_USER_NAME: z.string().trim().min(1).max(80).default('Owner'),
  ANCS_NEW_USER_PASSWORD: z.string().min(12, 'ANCS_NEW_USER_PASSWORD 至少 12 位'),
});

/** 内测邀请（D-04 invite 模式）：运营给邮箱发注册邀请 / 列出 / 撤销。配了发信就同时寄出邀请邮件。 */
export const signupInviteCliEnvSchema = z.object({
  DATABASE_URL: nonEmpty('DATABASE_URL（PostgreSQL 连接串）'),
  NODE_ENV: z.enum(['development', 'test', 'production']).optional(),
  BETTER_AUTH_URL: z.string().url('BETTER_AUTH_URL 必须是完整 URL').optional(),
  ...emailEnvShape,
});
export type SignupInviteCliEnv = z.infer<typeof signupInviteCliEnvSchema>;

/** 迁移任务（部署时一次性运行，只需要数据库连接）。 */
export const migrateCliEnvSchema = z.object({
  DATABASE_URL: nonEmpty('DATABASE_URL（PostgreSQL 连接串）'),
});

export const retentionCliEnvSchema = z.object({
  ...baseEnvShape,
  NODE_ENV: z.enum(['development', 'test', 'production']).optional(),
  BETTER_AUTH_URL: z.string().url('BETTER_AUTH_URL 必须是完整 URL').optional(),
  ANCS_STORAGE_DRIVER: storageDriverSchema,
  ANCS_STORAGE_SECRET: z.string().min(16, 'ANCS_STORAGE_SECRET 过短（≥16 字符）').optional(),
  ANCS_STORAGE_LOCAL_DIR: nonEmpty('ANCS_STORAGE_LOCAL_DIR').optional(),
  ANCS_STORAGE_PUBLIC_BASE_URL: z.string().url('ANCS_STORAGE_PUBLIC_BASE_URL 必须是完整 URL').optional(),
  ...s3StorageEnvShape,
  ANCS_TRASH_RETENTION_DAYS: z.coerce.number().int().min(1, 'ANCS_TRASH_RETENTION_DAYS ≥ 1').max(3650).optional(),
  ANCS_IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().min(1, 'ANCS_IDEMPOTENCY_TTL_HOURS ≥ 1').max(24 * 365).optional(),
});

export type RetentionCliEnv = z.infer<typeof retentionCliEnvSchema>;

/**
 * V6-2 Realtime Gateway（apps/realtime）：流式语音识别与指代绑定的独立进程。
 * 只校验语音会话的短期凭证（与 API 同一把 ANCS_VOICE_SESSION_SECRET），不读写工程。
 */
export const realtimeEnvSchema = z.object({
  DATABASE_URL: nonEmpty('DATABASE_URL（PostgreSQL 连接串）'),
  ...dbPoolEnvShape,
  NODE_ENV: z.enum(['development', 'test', 'production']).optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3002),
  /** 与 API 相同的语音会话签名密钥（网关用它校验浏览器带来的短期凭证） */
  ANCS_VOICE_SESSION_SECRET: z.string().min(32, 'ANCS_VOICE_SESSION_SECRET 未配置或过短（≥32 字符）'),
  /** 浏览器来源白名单（逗号分隔完整 origin）；留空 = BETTER_AUTH_URL 的 origin（非生产另加本地 Web 端口） */
  ANCS_ALLOWED_ORIGINS: z.string().optional(),
  BETTER_AUTH_URL: z.string().url('BETTER_AUTH_URL 必须是完整 URL').optional(),
  /**
   * 流式语音识别驱动：deepgram = 真实 Deepgram 流式识别（需 DEEPGRAM_API_KEY）；
   * openai = OpenAI 兼容的转写接口（/audio/transcriptions，需 OPENAI_API_KEY；网关自己断句、说话中定时出临时转写）；
   * 留空 = 不装配（连接时明确报"未配置"）
   */
  ANCS_REALTIME_ASR_DRIVER: z.enum(['deepgram', 'openai'], { message: 'ANCS_REALTIME_ASR_DRIVER 仅支持 deepgram | openai' }).optional(),
  /** OpenAI 兼容接口的 Key（官方或兼容网关发的 Key；只在网关进程内存中使用） */
  OPENAI_API_KEY: z.string().min(16, 'OPENAI_API_KEY 过短').optional(),
  /** OpenAI 兼容接口基址（含 /v1，缺省 https://api.openai.com/v1；兼容网关填它的地址） */
  ANCS_OPENAI_BASE_URL: z.string().url('ANCS_OPENAI_BASE_URL 必须是完整 URL').refine((value) => value.startsWith('https://'), 'ANCS_OPENAI_BASE_URL 必须是 https').optional(),
  /** openai 识别的转写模型（缺省 gpt-4o-transcribe；whisper-1 会带回逐词时间，其余模型的词时间由网关按断句估算） */
  ANCS_REALTIME_ASR_MODEL: nonEmpty('ANCS_REALTIME_ASR_MODEL').optional(),
  /** 说话中出临时转写的间隔（毫秒，缺省 900；0 = 只在一句话说完时转写一次） */
  ANCS_REALTIME_ASR_INTERIM_MS: z.coerce.number().int().min(0).max(10_000).optional(),
  /** AI 语音回应的合成驱动：openai = OpenAI 兼容 /audio/speech（需 OPENAI_API_KEY）；留空 = 客户端用浏览器朗读并如实标注 */
  ANCS_REALTIME_TTS_DRIVER: z.enum(['openai'], { message: 'ANCS_REALTIME_TTS_DRIVER 仅支持 openai' }).optional(),
  /** 语音回应模型（缺省 gpt-4o-mini-tts） */
  ANCS_REALTIME_TTS_MODEL: nonEmpty('ANCS_REALTIME_TTS_MODEL').optional(),
  /** 可切换的声音（JSON 数组 [{"id":"coral","name":"Coral"}]；只列实际可用的声音，缺省只有 coral） */
  ANCS_REALTIME_TTS_VOICES_JSON: nonEmpty('ANCS_REALTIME_TTS_VOICES_JSON').optional(),
  DEEPGRAM_API_KEY: z.string().min(16, 'DEEPGRAM_API_KEY 过短').optional(),
  /** 各语言的流式模型（缺省：中文 nova-2，英文 nova-3） */
  ANCS_DEEPGRAM_LIVE_MODEL_ZH: nonEmpty('ANCS_DEEPGRAM_LIVE_MODEL_ZH').optional(),
  ANCS_DEEPGRAM_LIVE_MODEL_EN: nonEmpty('ANCS_DEEPGRAM_LIVE_MODEL_EN').optional(),
  ANCS_ALLOW_MOCK_PROVIDERS: z.enum(['0', '1']).optional(),
});

export type RealtimeEnv = z.infer<typeof realtimeEnvSchema>;

function parseJsonOrNull(text: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { return null; }
}

export function crossCheckRealtimeEnv(value: RealtimeEnv): EnvIssue[] {
  const issues: EnvIssue[] = [];
  if (value.ANCS_REALTIME_ASR_DRIVER === 'deepgram' && value.DEEPGRAM_API_KEY === undefined) {
    issues.push({ variable: 'DEEPGRAM_API_KEY', message: 'ANCS_REALTIME_ASR_DRIVER=deepgram 时必须配置 DEEPGRAM_API_KEY（fail-closed，不回退 Mock）' });
  }
  if ((value.ANCS_REALTIME_ASR_DRIVER === 'openai' || value.ANCS_REALTIME_TTS_DRIVER === 'openai') && value.OPENAI_API_KEY === undefined) {
    issues.push({ variable: 'OPENAI_API_KEY', message: '识别或语音回应选择 openai 时必须配置 OPENAI_API_KEY（fail-closed，不回退 Mock）' });
  }
  if (value.ANCS_REALTIME_TTS_VOICES_JSON !== undefined) {
    const voices = parseJsonOrNull(value.ANCS_REALTIME_TTS_VOICES_JSON);
    if (!z.array(z.object({ id: z.string().min(1).max(64), name: z.string().min(1).max(80) }).strict()).min(1).max(20).safeParse(voices).success) {
      issues.push({ variable: 'ANCS_REALTIME_TTS_VOICES_JSON', message: 'ANCS_REALTIME_TTS_VOICES_JSON 必须是 1–20 个 {"id","name"} 组成的 JSON 数组' });
    }
  }
  if (value.ANCS_ALLOWED_ORIGINS !== undefined && value.ANCS_ALLOWED_ORIGINS.split(',').map((item) => item.trim()).filter((item) => item !== '').some((item) => originOf(item) !== item.replace(/\/+$/, '').toLowerCase())) {
    issues.push({ variable: 'ANCS_ALLOWED_ORIGINS', message: 'ANCS_ALLOWED_ORIGINS 必须是逗号分隔的完整 origin（如 https://app.example.com，不含路径）' });
  }
  return issues;
}

/** 旧 V4 流水线是否装配：显式配置优先；生产缺省 off（不装配测试替身，生产守卫不再需要 Mock 许可），其余缺省 mock */
export function resolveLegacyPipeline(value: Pick<ApiEnv, 'ANCS_LEGACY_PIPELINE' | 'NODE_ENV'>): 'mock' | 'off' {
  return value.ANCS_LEGACY_PIPELINE ?? (value.NODE_ENV === 'production' ? 'off' : 'mock');
}

/** Edge 允许的浏览器来源（V5-M4）：显式配置优先；否则 BETTER_AUTH_URL 的 origin，非生产另加本地 Web 开发端口。 */
export function resolveAllowedOrigins(value: Pick<ApiEnv, 'ANCS_ALLOWED_ORIGINS' | 'BETTER_AUTH_URL' | 'NODE_ENV' | 'PORT'>): string[] {
  if (value.ANCS_ALLOWED_ORIGINS !== undefined) {
    return value.ANCS_ALLOWED_ORIGINS.split(',').map((item) => item.trim().replace(/\/+$/, '')).filter((item) => item !== '');
  }
  const base = originOf(value.BETTER_AUTH_URL ?? `http://localhost:${String(value.PORT)}`) ?? `http://localhost:${String(value.PORT)}`;
  return value.NODE_ENV === 'production' ? [base] : [...new Set([base, 'http://localhost:3000', 'http://127.0.0.1:3000'])];
}

