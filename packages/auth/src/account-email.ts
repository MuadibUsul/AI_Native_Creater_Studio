import { AsyncLocalStorage } from 'node:async_hooks';
import type { AccountEmailLocale, EmailSender } from '@ancs/contracts';
import { renderAccountEmail, type AccountEmailContent, type AccountEmailKind } from './email-templates.js';

/**
 * 账号邮件的发送（D-04）。
 *
 * - **不等待投递**：接口答复不随"邮箱是否存在 / 发信快慢"变化（防枚举）；投递失败只进日志，不影响答复；
 * - **同一收件人限频**（allowRecipient）：防止有人反复点"重发"把别人的邮箱刷爆；被限的邮件静默丢弃；
 * - 邮件语言来自当前请求（`withAccountEmailContext`），Better Auth 的回调里拿不到请求参数，经异步上下文传入；
 * - 运营建号（CLI）时 `suppress` 掉验证邮件。
 */
export interface AccountEmailOptions {
  sender: EmailSender;
  /** 邮件里链接指向的网站地址（如 https://studio.example.com） */
  webBaseUrl: string;
  /** 邮件里显示的产品名 */
  productName: string;
  /** 同一收件人发信限频：返回 false 时不发 */
  allowRecipient?: (email: string, kind: AccountEmailKind) => Promise<boolean>;
  /** 投递失败（只记日志；不得写入邮件正文或链接） */
  onSendError?: (error: unknown, kind: AccountEmailKind) => void;
}

interface AccountEmailContext {
  locale?: AccountEmailLocale | undefined;
  suppress?: boolean;
}

const context = new AsyncLocalStorage<AccountEmailContext>();

/** 在请求处理里设定邮件语言（或抑制邮件）后调用 Better Auth。 */
export function withAccountEmailContext<T>(value: AccountEmailContext, run: () => Promise<T>): Promise<T> {
  return context.run(value, run);
}

/** 网站内的链接（路径 + 查询参数） */
export function accountLink(options: Pick<AccountEmailOptions, 'webBaseUrl'>, path: string, query: Record<string, string> = {}): string {
  const url = new URL(path, options.webBaseUrl.endsWith('/') ? options.webBaseUrl : `${options.webBaseUrl}/`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
}

/** 渲染并异步投递一封账号邮件；返回的 Promise 只在测试里等待（调用方不 await，防止时延泄露信息）。 */
export function dispatchAccountEmail(
  options: AccountEmailOptions,
  kind: AccountEmailKind,
  to: string,
  content: Omit<AccountEmailContent, 'productName'>,
  locale?: AccountEmailLocale,
): Promise<void> {
  const current = context.getStore();
  if (current?.suppress === true) return Promise.resolve();
  const language = locale ?? current?.locale ?? 'en';
  const message = renderAccountEmail(kind, language, to, { ...content, productName: options.productName });
  return (async () => {
    if (options.allowRecipient !== undefined && !(await options.allowRecipient(to.toLowerCase(), kind))) return;
    await options.sender.send(message);
  })().catch((error: unknown) => options.onSendError?.(error, kind));
}
