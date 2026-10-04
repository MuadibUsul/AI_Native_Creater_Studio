import type { WebhookVerifier } from '@ancs/contracts';
import { createHmacWebhookVerifier } from '@ancs/domain';

/**
 * Webhook 验签依赖（P03-06）：
 *   ANCS_WEBHOOK_SECRETS="mock.provider:secretA,heygen:secretB"
 * 每个 Provider 一个 HMAC 密钥（服务端持有；客户端不可见）。
 * 各 Provider 的签名头差异由 P06 的适配器归一化为同一接口（WebhookVerifier）。
 */

export interface WebhookDeps {
  verifiers: readonly WebhookVerifier[];
}

export function parseWebhookVerifiers(raw: string | undefined): readonly WebhookVerifier[] {
  if (raw === undefined || raw.trim() === '') return [];
  const verifiers: WebhookVerifier[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    const separator = trimmed.indexOf(':');
    if (separator <= 0) continue;
    const providerId = trimmed.slice(0, separator);
    const secret = trimmed.slice(separator + 1);
    if (secret.length < 8) continue; // 过短的密钥不具备安全强度：忽略（fail-closed：无验签器 → 一律拒绝）
    verifiers.push(createHmacWebhookVerifier(providerId, secret));
  }
  return verifiers;
}
