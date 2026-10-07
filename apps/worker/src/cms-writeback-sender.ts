import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { ApiFailure, CMS_ERROR_REASONS, ERROR_CODES, type CmsWritebackSender } from '@ancs/contracts';
import { assertSafeUrl, isBlockedAddress } from '@ancs/domain';

type LookupAddress = { address: string; family: number };

/** 真实 CMS HTTP 回写；DNS 全量校验后固定连接地址，避免校验后再次解析。 */
export function createHttpCmsWritebackSender(options: { lookup?: (hostname: string) => Promise<LookupAddress[]> } = {}): CmsWritebackSender {
  const lookup = options.lookup ?? (async (hostname: string) => dnsLookup(hostname, { all: true }));
  return {
    kind: 'http-pinned-dns',
    async send(input) {
      const url = assertSafeUrl(input.url);
      const addresses = await lookup(url.hostname);
      if (addresses.length === 0 || addresses.some((item) => isBlockedAddress(item.address))) {
        throw new ApiFailure(ERROR_CODES.FORBIDDEN, 'CMS 回写目标解析到内网或保留地址', 403, {
          reason: CMS_ERROR_REASONS.WRITEBACK_BLOCKED_TARGET,
        });
      }
      const selected = addresses[0];
      if (selected === undefined) throw new Error('CMS_WRITEBACK_DNS_EMPTY');
      return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let keptBytes = 0;
        let truncated = false;
        const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
          {
            protocol: url.protocol,
            hostname: selected.address,
            family: selected.family,
            port: url.port === '' ? undefined : Number(url.port),
            path: `${url.pathname}${url.search}`,
            method: 'POST',
            headers: { ...input.headers, host: url.host, 'content-length': String(Buffer.byteLength(input.body)) },
            ...(url.protocol === 'https:' ? { servername: url.hostname } : {}),
          },
          (response) => {
            response.on('data', (chunk: Buffer | string) => {
              const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              const remaining = input.maxResponseBytes - keptBytes;
              if (remaining > 0) {
                const kept = bytes.subarray(0, remaining);
                chunks.push(kept);
                keptBytes += kept.length;
              }
              if (bytes.length > Math.max(remaining, 0)) truncated = true;
            });
            response.on('end', () => {
              const headers: Record<string, string> = {};
              for (const [key, value] of Object.entries(response.headers)) {
                if (typeof value === 'string') headers[key] = value;
                else if (Array.isArray(value)) headers[key] = value.join(', ');
              }
              resolve({ status: response.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString('utf8'), truncated });
            });
            response.on('error', reject);
          },
        );
        request.setTimeout(input.timeoutMs, () => request.destroy(new Error('CMS_WRITEBACK_TIMEOUT')));
        request.on('error', reject);
        request.end(input.body);
      });
    },
  };
}
