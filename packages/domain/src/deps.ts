import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type {
  AlignmentProvider,
  ArticleFetcher,
  AudioSynthesisAdapter,
  CmsWritebackSender,
  CredentialCipher,
  DistributionProvider,
  JobQueueAdapter,
  LlmAdapter,
  ObjectStorageAdapter,
  PackPlugin,
  PlatformCredentialRegistry,
  ProviderTestHook,
  ResultFetcher,
} from '@ancs/contracts';
import type { BillingPolicy } from './billing.js';
import type { RetryPolicy } from './jobs.js';
import type { RetentionConfig } from './retention.js';

/**
 * 领域层依赖（端口集合）：由进程入口装配后注入每个领域服务。
 * 只声明接口（contracts 中的端口与本包的策略类型），领域层不依赖任何具体适配器（providers/*）。
 * （V5-M3：自 channels.ts 移出——核心依赖类型不挂在某个业务模块上。）
 */
export interface DomainDeps {
  db: NodePgDatabase;
  /** 自动快照间隔（每 N 个编辑事件，§23.2）；默认 50，测试可调小 */
  autoSnapshotEveryEvents?: number;
  /** 对象存储适配器（P02-04；接口在 contracts，实现由 API 注入，domain 不依赖 providers/*） */
  storage?: ObjectStorageAdapter;
  /** 上传意图/直传 URL 的 TTL 秒数（§26.1）；默认 15 分钟，测试可调小/构造过期 */
  uploadIntentTtlSeconds?: number;
  /**
   * 语音会话短期凭证的签名密钥（N05-01）。未配置时创建会话 fail-closed（501），
   * **绝不**回退到 Provider 长期 Key。
   */
  voiceSessionSecret?: string;
  /** 保留策略配置（P02-05）：Trash 天数与幂等键 TTL；默认 30 天 / 24 小时 */
  retention?: RetentionConfig;
  /** 任务队列适配器（P03-01）：缺省为 DB 轮询（权威状态即队列）；Redis/BullMQ 见 providers/queue-bullmq */
  queue?: JobQueueAdapter;
  /** 重试退避策略（P03-02）：base/cap/jitter + 可注入随机源（测试确定性） */
  retryPolicy?: RetryPolicy;
  /** Pack 插件实例（P11-03；接口在 contracts，官方/测试实例由 API 装配注入） */
  packPlugins?: readonly PackPlugin[];
  /** 分发 Provider 实例（P13-01；接口在 contracts，Mock/真实实例由 API 装配注入） */
  distributionProviders?: readonly DistributionProvider[];
  /** 凭据密文服务（P03-04；接口在 contracts，实现由 API/Worker 注入，domain 不依赖 providers/*） */
  credentials?: CredentialCipher;
  /** 平台托管凭据来源（P03-04；运行时环境/KMS） */
  platformCredentials?: PlatformCredentialRegistry;
  /** Provider 连接测试钩子（P03-04/P03-07：真实适配器或 Mock） */
  providerTestHooks?: readonly ProviderTestHook[];
  /** 计费策略（P03-05；§35.2：BYOK 计费不得硬编码在 generation service） */
  billingPolicy?: BillingPolicy;
  /** 结果拉取器（P03-06）：HTTP 等 I/O 由宿主注入（apps/worker 的 HTTP 实现；测试脚本化） */
  resultFetcher?: ResultFetcher;
  /** 文章抓取器（P04-01）：URL 输入归一化的 I/O（逐跳 SSRF 校验由实现方保证） */
  articleFetcher?: ArticleFetcher;
  /** CMS 回写发送器（P13-07）：真实 HTTP 由 Worker 注入；domain 只消费接口。 */
  cmsWritebackSender?: CmsWritebackSender;
  /** LLM 适配器（P04-03）：叙事/导演等结构化生成（真实适配器 P06-01；Mock 见 providers/mock-llm） */
  llm?: LlmAdapter;
  /** TTS 适配器（P06-03）：逐段语音合成（必须带词级时间戳或配置 aligner；Mock 见 providers/mock-tts） */
  tts?: AudioSynthesisAdapter;
  /** 强制对齐器（P06-03）：Provider 无时间戳时使用；首期不接受按字数估计（§5.1） */
  aligner?: AlignmentProvider;
}
