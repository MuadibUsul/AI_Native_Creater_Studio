import {
  ProviderRateLimitedError,
  ProviderSubmissionUnknownError,
  providerCallbackSchema,
  stockResultUsability,
  type AssetSearchProvider,
  type StockSearchRequest,
  type StockSearchResult,
  type GenerationCancelResult,
  type GenerationProvider,
  type GenerationStatusResult,
  type GenerationSubmitRequest,
  type GenerationSubmitResult,
  type ProviderCallback,
} from '@ancs/contracts';

/**
 * Mock Provider（P03-07 / 计划 P03 退出条件）。
 *
 * 用途：在**不触碰真实付费服务**的前提下，让 CI 确定性重现各类故障：
 *   success（成功）/ slow（慢任务）/ rate_limited（429）/ submission_unknown（提交结果未知）/
 *   duplicate_callback（重复回调）/ cancel_fails（取消失败）/ result_missing（结果永不到达 → 对账）。
 *
 * 设计：
 * - 脚本按 providerJobId 存放（提交时按调用序取下一个脚本；也支持"整条 Provider 固定脚本"）；
 * - getStatus 按 `pollsBeforeTerminal`（默认 2）推进：先 QUEUED/RUNNING，再终态（确定性、无定时器）；
 * - `buildCallback(providerJobId)` 生成 P03-06 契约的归一化回调（回调投递由调用方执行——
 *   真实 HTTP 或进程内 processProviderCallback 共用同一状态迁移服务）。
 */

export const MOCK_BEHAVIORS = [
  'success',
  'slow',
  'rate_limited',
  'submission_unknown',
  'duplicate_callback',
  'cancel_fails',
  'result_missing',
] as const;

export type MockBehavior = (typeof MOCK_BEHAVIORS)[number];

export interface MockProviderOptions {
  providerId?: string;
  /** 默认行为（未显式排队的提交使用） */
  defaultBehavior?: MockBehavior;
  /** 结果 URL 生成（默认使用 providerJobId 构造的伪临时地址） */
  resultUrlFor?: (providerJobId: string, index: number) => string;
  /** 结果字节（默认 33 字节 PNG 头；测试也可覆盖） */
  resultBytesFor?: (providerJobId: string, index: number) => Uint8Array;
  /** 轮询多少次后进入终态（默认 2：先 RUNNING 再终态） */
  pollsBeforeTerminal?: number;
  /** 临时 URL 的过期时长（毫秒；默认 15 分钟） */
  resultTtlMs?: number;
}

interface SubmissionRecord {
  providerJobId: string;
  behavior: MockBehavior;
  polls: number;
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'CANCELLED';
  canceled: boolean;
  failureReason: string | null;
}

const PNG_PREFIX = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x02, 0x80, 0x00, 0x00, 0x01, 0x68, 0x08, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

function defaultResultBytes(seed: number): Uint8Array {
  const bytes = new Uint8Array(PNG_PREFIX);
  bytes[26] = seed & 0xff;
  return bytes;
}

export class MockGenerationProvider implements GenerationProvider {
  readonly providerId: string;
  /** 关键：测试可读取"被提交过的请求"以断言不存在重复付费提交 */
  readonly submissions: { providerJobId: string; behavior: MockBehavior; jobId: string; inputHash: string }[] = [];
  readonly cancelAttempts: string[] = [];
  /** getStatus 调用次数（断言轮询补偿次数） */
  statusCalls = 0;

  private readonly options: Required<Omit<MockProviderOptions, 'providerId'>> & { providerId: string };
  private readonly records = new Map<string, SubmissionRecord>();
  private readonly queue: MockBehavior[] = [];
  private counter = 0;

  constructor(options: MockProviderOptions = {}) {
    this.providerId = options.providerId ?? 'mock.provider';
    this.options = {
      providerId: this.providerId,
      defaultBehavior: options.defaultBehavior ?? 'success',
      resultUrlFor:
        options.resultUrlFor ?? ((providerJobId, index) => `https://mock.provider/ephemeral/${providerJobId}/result-${String(index)}.png`),
      resultBytesFor: options.resultBytesFor ?? ((providerJobId, index) => defaultResultBytes(providerJobId.length + index)),
      pollsBeforeTerminal: options.pollsBeforeTerminal ?? 2,
      resultTtlMs: options.resultTtlMs ?? 15 * 60 * 1000,
    };
  }

  /** 排队下一次提交的行为（按提交顺序消费） */
  scriptNext(behavior: MockBehavior): this {
    this.queue.push(behavior);
    return this;
  }

  scriptAll(behaviors: MockBehavior[]): this {
    this.queue.push(...behaviors);
    return this;
  }

  behaviorFor(providerJobId: string): MockBehavior | null {
    return this.records.get(providerJobId)?.behavior ?? null;
  }

  async submit(input: { secret: string; request: GenerationSubmitRequest }): Promise<GenerationSubmitResult> {
    if (input.secret.trim() === '') {
      // 凭据层已保证非空；Mock 同样 fail-closed（避免把"空凭据也能通过"带进真实链路）
      throw new Error('Mock Provider：缺少凭据（secret 为空）');
    }
    const behavior = this.queue.shift() ?? this.options.defaultBehavior;

    if (behavior === 'rate_limited') {
      throw new ProviderRateLimitedError('Mock Provider：429 Too Many Requests', 1);
    }
    if (behavior === 'submission_unknown') {
      // 提交"可能已经到达上游"：抛未知错误 → 上层标记对账，不得自动重复付费提交
      throw new ProviderSubmissionUnknownError('Mock Provider：提交结果未知（模拟网络中断）');
    }

    this.counter += 1;
    const providerJobId = `mock_${String(this.counter).padStart(4, '0')}_${Math.random().toString(16).slice(2, 8)}`;
    this.records.set(providerJobId, {
      providerJobId,
      behavior,
      polls: 0,
      status: 'QUEUED',
      canceled: false,
      failureReason: null,
    });
    this.submissions.push({ providerJobId, behavior, jobId: input.request.jobId, inputHash: input.request.inputHash });
    return { providerJobId, state: 'QUEUED' };
  }

  async getStatus(input: { providerJobId: string }): Promise<GenerationStatusResult> {
    this.statusCalls += 1;
    const record = this.records.get(input.providerJobId);
    if (record === undefined) return { state: 'UNKNOWN' };
    if (record.canceled) return { state: 'CANCELLED' };

    record.polls += 1;
    switch (record.behavior) {
      case 'result_missing':
        // 任务在 Provider 侧完成但结果永不可得 → 上层标记对账（不自动重复付费）
        return { state: record.polls >= this.options.pollsBeforeTerminal ? 'UNKNOWN' : 'RUNNING' };
      case 'slow':
        // 慢任务：显著更多的轮询后才完成（CI 无需真实等待）
        record.status = record.polls >= this.options.pollsBeforeTerminal * 3 ? 'SUCCEEDED' : 'RUNNING';
        break;
      default:
        record.status = record.polls >= this.options.pollsBeforeTerminal ? 'SUCCEEDED' : 'RUNNING';
        break;
    }
    if (record.status === 'SUCCEEDED') {
      return { state: 'SUCCEEDED', results: this.resultsFor(record) };
    }
    return { state: record.status };
  }

  async cancel(input: { providerJobId: string }): Promise<GenerationCancelResult> {
    this.cancelAttempts.push(input.providerJobId);
    const record = this.records.get(input.providerJobId);
    if (record === undefined) return { ok: false, reason: 'UNKNOWN_PROVIDER_JOB' };
    if (record.behavior === 'cancel_fails') {
      // 取消失败：任务必须保持 CANCEL_REQUESTED 供人工介入（不得假装已取消）
      return { ok: false, reason: 'PROVIDER_CANCEL_REJECTED' };
    }
    record.canceled = true;
    return { ok: true };
  }

  /** 生成"重复投递"的第二次回调（同 eventId；上层 replay 防护必须幂等处理） */
  duplicateOf(callback: ProviderCallback): ProviderCallback {
    return providerCallbackSchema.parse({ ...callback });
  }

  /** 构造归一化回调（P03-06 契约；投递方式由调用方决定：HTTP 或进程内共用服务） */
  buildCallback(providerJobId: string): ProviderCallback {
    const record = this.records.get(providerJobId);
    if (record === undefined) throw new Error(`Mock Provider：未知 providerJobId=${providerJobId}`);
    return providerCallbackSchema.parse({
      eventId: `evt_${providerJobId}`,
      eventType: 'job.succeeded',
      providerJobId,
      attempt: 1,
      results: this.resultsFor(record),
      error: null,
    });
  }

  private resultsFor(record: SubmissionRecord): ProviderCallback['results'] {
    const index = 0;
    const url = this.options.resultUrlFor(record.providerJobId, index);
    const bytes = this.options.resultBytesFor(record.providerJobId, index);
    return [
      {
        url,
        contentType: 'image/png',
        sizeBytes: bytes.byteLength,
        checksumSha256: null,
        assetType: 'GENERATED_IMAGE',
        expiresAt: new Date(Date.now() + this.options.resultTtlMs).toISOString(),
      },
    ];
  }

  /** 结果字节（供测试的结果拉取器使用：URL → 字节 / 内容类型） */
  resultPayloadFor(providerJobId: string): { bytes: Uint8Array; contentType: string } | null {
    const record = this.records.get(providerJobId);
    if (record === undefined) return null;
    return { bytes: this.options.resultBytesFor(providerJobId, 0), contentType: 'image/png' };
  }
}
/* ---------- P10-03：素材搜索 / 图像生成（Mock 同构）与 Runway fail-closed 骨架 ---------- */

/** 最小 PNG（8×8；头部合法可被嗅探/宽高探测）——Mock 下载结果，**不冒充真实素材** */
function mockPngBytes(r: number, g: number, b: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  bytes[19] = 8; // width 8
  bytes[23] = 8; // height 8
  bytes[24] = 8; // bit depth
  bytes[25] = 2; // color type RGB
  bytes[26] = r & 0xff;
  bytes[27] = g & 0xff;
  bytes[28] = b & 0xff;
  return bytes;
}

/**
 * Mock 素材搜索（P10-03）：确定性结果集，**覆盖三类许可状态**——
 * ① 授权可用（LICENSED_STOCK + 许可证引用 + 署名文本）；② **无许可（licenseType=null → usable=false，
 * 不得冒充已授权）**；③ 需署名但缺署名文本（usable=false，明确原因）。
 * `lookup` 供获取前**服务端复核**（不信任客户端提交的许可字段）。
 */
export class MockAssetSearchProvider implements AssetSearchProvider {
  readonly providerId: string;
  /** 可观测调用记录 */
  readonly calls: { search: number; lookup: number; fetch: number } = { search: 0, lookup: 0, fetch: 0 };

  constructor(options: { providerId?: string } = {}) {
    this.providerId = options.providerId ?? 'mock-stock';
  }

  private candidates(): StockSearchResult[] {
    const base = {
      providerId: this.providerId,
      kind: 'IMAGE' as const,
      width: 8,
      height: 8,
      durationMs: null,
      previewUrl: null,
    };
    const withUsability = (result: Omit<StockSearchResult, 'usable' | 'unusableReason'>): StockSearchResult => {
      const usability = stockResultUsability(result.license);
      return { ...result, usable: usability.usable, unusableReason: usability.reason };
    };
    return [
      withUsability({
        ...base,
        providerAssetId: 'mockimg_licensed_a',
        title: '素材 A（已授权）',
        license: {
          licenseType: 'LICENSED_STOCK',
          licenseReference: 'MOCK-LIC-0001',
          attributionRequired: true,
          attributionText: '素材：MockStock / 摄影 A（许可：MOCK-LIC-0001）',
          usageRestrictions: '仅限本平台成片使用',
          sourceUrl: 'https://stock.mock.local/asset/a',
          acquiredAt: null,
        },
      }),
      withUsability({
        ...base,
        providerAssetId: 'mockimg_no_license_b',
        title: '素材 B（许可未知——不可用）',
        license: {
          licenseType: null,
          licenseReference: null,
          attributionRequired: false,
          attributionText: null,
          usageRestrictions: null,
          sourceUrl: null,
          acquiredAt: null,
        },
      }),
      withUsability({
        ...base,
        providerAssetId: 'mockimg_cc_c',
        title: '素材 C（需署名但缺失署名文本——不可用）',
        license: {
          licenseType: 'CREATIVE_COMMONS',
          licenseReference: 'CC-BY-4.0',
          attributionRequired: true,
          attributionText: null,
          usageRestrictions: null,
          sourceUrl: 'https://stock.mock.local/asset/c',
          acquiredAt: null,
        },
      }),
    ];
  }

  async search(input: StockSearchRequest): Promise<StockSearchResult[]> {
    this.calls.search += 1;
    if (input.kind !== 'IMAGE') return []; // Mock 未模拟 VIDEO/MUSIC（诚实空结果，不造假数据）
    const query = input.query.trim().toLowerCase();
    const matched = this.candidates().filter((result) => query === '' || result.title.toLowerCase().includes(query) || query.includes('mock') || result.providerAssetId.includes(query));
    const filtered = input.usableOnly === true ? matched.filter((result) => result.usable) : matched;
    return filtered.slice(0, input.limit ?? 20);
  }

  async lookup(input: { providerAssetId: string }): Promise<StockSearchResult | null> {
    this.calls.lookup += 1;
    return this.candidates().find((result) => result.providerAssetId === input.providerAssetId) ?? null;
  }

  async fetchAsset(input: { providerAssetId: string }): Promise<{ bytes: Uint8Array; contentType: string }> {
    this.calls.fetch += 1;
    const result = await this.lookup(input);
    if (result === null) throw new Error(`MockStock 资产不存在：${input.providerAssetId}`);
    return { bytes: mockPngBytes(20, 120, 200), contentType: 'image/png' };
  }
}

/**
 * Mock 图像生成（P10-03）：实现 `GenerationProvider`（operation `image.generate`），
 * 结果 descriptor 与 Mock Provider 同构（临时 URL → 结果回收链路写入自有存储；origin=PROVIDER_GENERATED）。
 * 接入真实图像 Provider 时替换本实现（凭据 + 端点核验，**不得以未核验实现冒充接入**）。
 */
export class MockImageGenerationProvider implements GenerationProvider {
  readonly providerId: string;
  /** 可观测：提交记录（operation/提示词长度） */
  readonly submissions: { operation: string; promptLength: number }[] = [];

  constructor(options: { providerId?: string } = {}) {
    this.providerId = options.providerId ?? 'mock-image';
  }

  async submit(input: { secret: string; request: GenerationSubmitRequest }): Promise<GenerationSubmitResult> {
    if (input.secret.trim() === '') {
      // 与 Mock Provider 同纪律：空凭据 fail-closed（避免把"空凭据也能过"带进真实链路）
      throw new Error('MockImageGenerationProvider：缺少凭据（secret 为空）');
    }
    this.submissions.push({ operation: input.request.operation, promptLength: String(input.request.parameters['prompt'] ?? '').length });
    const providerJobId = `mockimgjob_${String(this.submissions.length).padStart(4, '0')}`;
    return { providerJobId, state: 'SUCCEEDED' };
  }

  async getStatus(input: { secret: string; providerJobId: string }): Promise<GenerationStatusResult> {
    if (!input.providerJobId.startsWith('mockimgjob_')) return { state: 'UNKNOWN' };
    const bytes = mockPngBytes(200, 80, 40);
    return {
      state: 'SUCCEEDED',
      results: [
        {
          url: `mock-image://${input.providerJobId}/0.png`,
          contentType: 'image/png',
          sizeBytes: bytes.byteLength,
          checksumSha256: null,
          assetType: 'GENERATED_IMAGE',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        },
      ],
    };
  }

  async cancel(input: { secret: string; providerJobId: string }): Promise<GenerationCancelResult> {
    return { ok: false, reason: input.providerJobId.startsWith('mockimgjob_') ? 'ALREADY_SUCCEEDED' : 'UNKNOWN_PROVIDER_JOB' };
  }

  /** 结果字节（供结果回收链路/测试的拉取器解析 `mock-image://` URL） */
  resultPayloadFor(providerJobId: string): { bytes: Uint8Array; contentType: string } | null {
    return providerJobId.startsWith('mockimgjob_') ? { bytes: mockPngBytes(200, 80, 40), contentType: 'image/png' } : null;
  }
}

/** Runway（AI Video）**未实现**——明确信息（不得以未核验实现冒充真实接入） */
export const RUNWAY_NOT_IMPLEMENTED_MESSAGE =
  'Runway 适配器未实现（BLOCKED：需 API 凭据 + 端点核验）。以未核验的 HTTP 实现冒充"真实接入"被明确禁止——接入时实现 GenerationProvider 并回放公共契约测试。';

/**
 * Runway fail-closed 骨架（P10-03）：只做**显式拒绝**——任何提交/查询都明确失败并说明阻塞原因；
 * 不发送任何网络请求（避免"看起来接入了"的假象）。接入路径：实现 GenerationProvider →
 * 过 P03-07 公共契约测试 → 以真实凭据回放 P06 矩阵。
 */
export class RunwayGenerationAdapter implements GenerationProvider {
  readonly providerId = 'runway';
  readonly apiKey: string | null;

  constructor(options: { apiKey?: string } = {}) {
    this.apiKey = options.apiKey === undefined || options.apiKey === '' ? null : options.apiKey;
  }

  async submit(_input: { secret: string; request: GenerationSubmitRequest }): Promise<never> {
    throw new Error(RUNWAY_NOT_IMPLEMENTED_MESSAGE);
  }

  async getStatus(_input: { secret: string; providerJobId: string }): Promise<never> {
    throw new Error(RUNWAY_NOT_IMPLEMENTED_MESSAGE);
  }

  async cancel(_input: { secret: string; providerJobId: string }): Promise<never> {
    throw new Error(RUNWAY_NOT_IMPLEMENTED_MESSAGE);
  }
}
