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
  /**
   * 供应商凭据信封加密密钥（`v1:<base64 32B>[,v2:...]`）。
   * **生产环境必填**：一个密钥泄露不应同时打穿会话、签名 URL 与供应商凭据；
   * 非生产可省略（由 BETTER_AUTH_SECRET 派生兜底并告警，见 credential-vault-local）。
   */
  ANCS_CREDENTIAL_KEYS: z.string().min(1, 'ANCS_CREDENTIAL_KEYS 不能为空字符串（格式 v1:<base64 32B>）').optional(),
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
  /** 限流开关（生产不得关闭） */
  ANCS_RATE_LIMIT: z.enum(['enforce', 'off'], { message: 'ANCS_RATE_LIMIT 仅支持 enforce | off' }).default('enforce'),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;

/** 跨字段规则（API；schema 之外的可读校验；返回全部问题）。 */
export function crossCheckApiEnv(value: ApiEnv): EnvIssue[] {
  const issues: EnvIssue[] = [];
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
  NODE_ENV: z.enum(['development', 'test', 'production']).optional(),
  /** 存储签名 URL 的公开基址回退（与 API 同一规则：ANCS_STORAGE_PUBLIC_BASE_URL → BETTER_AUTH_URL → localhost） */
  BETTER_AUTH_URL: z.string().url('BETTER_AUTH_URL 必须是完整 URL').optional(),
  ANCS_DEFAULT_PLAN: z.enum(['FREE', 'CREATOR', 'PRO', 'STUDIO', 'ENTERPRISE'], { message: 'ANCS_DEFAULT_PLAN 仅支持 FREE/CREATOR/PRO/STUDIO/ENTERPRISE' }).optional(),
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
  ANCS_STORAGE_SECRET: z.string().min(16, 'ANCS_STORAGE_SECRET 过短（≥16 字符）').optional(),
  ANCS_STORAGE_LOCAL_DIR: nonEmpty('ANCS_STORAGE_LOCAL_DIR').optional(),
  ANCS_STORAGE_PUBLIC_BASE_URL: z.string().url('ANCS_STORAGE_PUBLIC_BASE_URL 必须是完整 URL').optional(),
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
   * 视觉分析驱动（V6-1b）：process = 运维配置的子进程；anthropic = 视觉模型逐帧写镜头说明（需 ANTHROPIC_API_KEY）。
   * 缺省：配置了 ANCS_VISUAL_ANALYSIS_EXECUTABLE 则为 process，否则不装配（视觉分析任务明确失败"未配置"）。
   */
  ANCS_VISUAL_ANALYSIS_DRIVER: z.enum(['process', 'anthropic'], { message: 'ANCS_VISUAL_ANALYSIS_DRIVER 仅支持 process | anthropic' }).optional(),
  /** 视觉理解模型 id（缺省 claude-haiku-5-5） */
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
   * 通用导演 Agent 的模型驱动（V6-1）：anthropic = 真实 Claude（需 ANTHROPIC_API_KEY）。
   * 未配置时不装配真实模型：AI 轮次明确失败（AGENT_MODEL_NOT_CONFIGURED），不回退 Mock。
   */
  ANCS_AGENT_DRIVER: z.enum(['anthropic'], { message: 'ANCS_AGENT_DRIVER 仅支持 anthropic' }).optional(),
  /** Claude API Key（只在 Worker 进程内存中使用；绝不写日志、不进错误返回、不下发客户端） */
  ANTHROPIC_API_KEY: z.string().min(16, 'ANTHROPIC_API_KEY 过短').optional(),
  /** 导演模型 id（缺省 claude-opus-5-5） */
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
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/** 跨字段规则（schema 之外的可读校验；返回全部问题）。 */
export function crossCheckWorkerEnv(value: WorkerEnv): EnvIssue[] {
  const issues: EnvIssue[] = [];
  if (value.ANCS_QUEUE_DRIVER === 'bullmq' && value.REDIS_URL === undefined) {
    issues.push({ variable: 'REDIS_URL', message: 'ANCS_QUEUE_DRIVER=bullmq 时必须配置 REDIS_URL' });
  }
  if (value.NODE_ENV === 'production' && value.ANCS_STORAGE_SECRET === undefined) {
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
  if (value.ANCS_AGENT_DRIVER === 'anthropic' && value.ANTHROPIC_API_KEY === undefined) {
    issues.push({ variable: 'ANTHROPIC_API_KEY', message: 'ANCS_AGENT_DRIVER=anthropic 时必须配置 ANTHROPIC_API_KEY（fail-closed，不回退 Mock）' });
  }
  if (value.ANCS_ASR_DRIVER === 'process' && value.ANCS_ASR_EXECUTABLE === undefined) {
    issues.push({ variable: 'ANCS_ASR_EXECUTABLE', message: 'ANCS_ASR_DRIVER=process 时必须配置 ANCS_ASR_EXECUTABLE' });
  }
  if (value.ANCS_WORKER_HEARTBEAT_MS !== undefined && value.ANCS_WORKER_HEARTBEAT_MS >= value.ANCS_WORKER_LEASE_SECONDS * 1000) {
    issues.push({ variable: 'ANCS_WORKER_HEARTBEAT_MS', message: '心跳间隔必须小于租约时长（否则租约会在两次心跳之间过期）' });
  }
  return issues;
}

/** 保留清理 CLI 环境（apps/api retention:sweep）：与 API 同一存储签名规则。 */
export const retentionCliEnvSchema = z.object({
  ...baseEnvShape,
  NODE_ENV: z.enum(['development', 'test', 'production']).optional(),
  BETTER_AUTH_URL: z.string().url('BETTER_AUTH_URL 必须是完整 URL').optional(),
  ANCS_STORAGE_DRIVER: z.enum(['local'], { message: 'ANCS_STORAGE_DRIVER 仅支持 local' }).default('local'),
  ANCS_STORAGE_SECRET: z.string().min(16, 'ANCS_STORAGE_SECRET 过短（≥16 字符）').optional(),
  ANCS_STORAGE_LOCAL_DIR: nonEmpty('ANCS_STORAGE_LOCAL_DIR').optional(),
  ANCS_STORAGE_PUBLIC_BASE_URL: z.string().url('ANCS_STORAGE_PUBLIC_BASE_URL 必须是完整 URL').optional(),
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
  NODE_ENV: z.enum(['development', 'test', 'production']).optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3002),
  /** 与 API 相同的语音会话签名密钥（网关用它校验浏览器带来的短期凭证） */
  ANCS_VOICE_SESSION_SECRET: z.string().min(32, 'ANCS_VOICE_SESSION_SECRET 未配置或过短（≥32 字符）'),
  /** 浏览器来源白名单（逗号分隔完整 origin）；留空 = BETTER_AUTH_URL 的 origin（非生产另加本地 Web 端口） */
  ANCS_ALLOWED_ORIGINS: z.string().optional(),
  BETTER_AUTH_URL: z.string().url('BETTER_AUTH_URL 必须是完整 URL').optional(),
  /** 流式语音识别驱动：deepgram = 真实 Deepgram（需 DEEPGRAM_API_KEY）；留空 = 不装配（连接时明确报"未配置"） */
  ANCS_REALTIME_ASR_DRIVER: z.enum(['deepgram'], { message: 'ANCS_REALTIME_ASR_DRIVER 仅支持 deepgram' }).optional(),
  DEEPGRAM_API_KEY: z.string().min(16, 'DEEPGRAM_API_KEY 过短').optional(),
  /** 各语言的流式模型（缺省：中文 nova-2，英文 nova-3） */
  ANCS_DEEPGRAM_LIVE_MODEL_ZH: nonEmpty('ANCS_DEEPGRAM_LIVE_MODEL_ZH').optional(),
  ANCS_DEEPGRAM_LIVE_MODEL_EN: nonEmpty('ANCS_DEEPGRAM_LIVE_MODEL_EN').optional(),
  ANCS_ALLOW_MOCK_PROVIDERS: z.enum(['0', '1']).optional(),
});

export type RealtimeEnv = z.infer<typeof realtimeEnvSchema>;

export function crossCheckRealtimeEnv(value: RealtimeEnv): EnvIssue[] {
  const issues: EnvIssue[] = [];
  if (value.ANCS_REALTIME_ASR_DRIVER === 'deepgram' && value.DEEPGRAM_API_KEY === undefined) {
    issues.push({ variable: 'DEEPGRAM_API_KEY', message: 'ANCS_REALTIME_ASR_DRIVER=deepgram 时必须配置 DEEPGRAM_API_KEY（fail-closed，不回退 Mock）' });
  }
  if (value.ANCS_ALLOWED_ORIGINS !== undefined && value.ANCS_ALLOWED_ORIGINS.split(',').map((item) => item.trim()).filter((item) => item !== '').some((item) => originOf(item) !== item.replace(/\/+$/, '').toLowerCase())) {
    issues.push({ variable: 'ANCS_ALLOWED_ORIGINS', message: 'ANCS_ALLOWED_ORIGINS 必须是逗号分隔的完整 origin（如 https://app.example.com，不含路径）' });
  }
  return issues;
}

/** Edge 允许的浏览器来源（V5-M4）：显式配置优先；否则 BETTER_AUTH_URL 的 origin，非生产另加本地 Web 开发端口。 */
export function resolveAllowedOrigins(value: Pick<ApiEnv, 'ANCS_ALLOWED_ORIGINS' | 'BETTER_AUTH_URL' | 'NODE_ENV' | 'PORT'>): string[] {
  if (value.ANCS_ALLOWED_ORIGINS !== undefined) {
    return value.ANCS_ALLOWED_ORIGINS.split(',').map((item) => item.trim().replace(/\/+$/, '')).filter((item) => item !== '');
  }
  const base = originOf(value.BETTER_AUTH_URL ?? `http://localhost:${String(value.PORT)}`) ?? `http://localhost:${String(value.PORT)}`;
  return value.NODE_ENV === 'production' ? [base] : [...new Set([base, 'http://localhost:3000', 'http://127.0.0.1:3000'])];
}

