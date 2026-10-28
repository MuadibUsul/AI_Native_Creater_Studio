import { createHash } from 'node:crypto';
import { accountLink, dispatchAccountEmail, type AccountEmailOptions } from '@ancs/auth';
import type { AccountEmailLocale, EmailSender, RateLimitRule, RateLimitStore, SignupMode } from '@ancs/contracts';
import { user, workspaces } from '@ancs/db';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { describeSmtpError, LogEmailSender, SmtpEmailSender } from '@ancs/providers-email-smtp';
import { TokenBuckets } from './edge.js';

/**
 * 账号邮件装配（D-04）：按已校验的配置选择发信驱动，加上"同一收件人限频"。
 *
 * 限频：同一邮箱同一类邮件最多连发 3 封，之后约每 5 分钟恢复 1 封（多台 API 共用 Redis 时全局生效，
 * 否则每进程各算）。被限的邮件静默不发，接口答复不变（不暴露邮箱是否存在）。
 */
export interface AccountsDeps {
  signupMode: SignupMode;
  /** 未配置发信时为 undefined（不能注册、不能找回密码） */
  email?: AccountEmailOptions;
}

export const RECIPIENT_EMAIL_RULE: RateLimitRule = { capacity: 3, perMinute: 0.2 };

export interface EmailConfig {
  ANCS_EMAIL_DRIVER?: 'log' | 'smtp' | undefined;
  ANCS_SMTP_URL?: string | undefined;
  ANCS_EMAIL_FROM?: string | undefined;
  ANCS_PUBLIC_WEB_URL?: string | undefined;
  ANCS_PRODUCT_NAME: string;
  BETTER_AUTH_URL?: string | undefined;
}

/** 按配置建发信驱动；未配置发信返回 null。 */
export function createEmailSender(config: EmailConfig): EmailSender | null {
  if (config.ANCS_EMAIL_DRIVER === 'smtp') return new SmtpEmailSender({ url: config.ANCS_SMTP_URL!, from: config.ANCS_EMAIL_FROM! });
  if (config.ANCS_EMAIL_DRIVER === 'log') return new LogEmailSender();
  return null;
}

export function createAccountEmailOptions(input: {
  config: EmailConfig;
  sender: EmailSender;
  fallbackWebBaseUrl: string;
  rateLimitStore?: RateLimitStore | undefined;
  log: { warn: (object: Record<string, unknown>, message: string) => void };
  now?: () => number;
}): AccountEmailOptions {
  const buckets = new TokenBuckets();
  const now = input.now ?? Date.now;
  const take = async (key: string): Promise<boolean> => {
    if (input.rateLimitStore !== undefined) {
      try {
        return (await input.rateLimitStore.take(key, RECIPIENT_EMAIL_RULE)).allowed;
      } catch {
        // 共享存储不可用：退回本进程计数
      }
    }
    return buckets.take(key, RECIPIENT_EMAIL_RULE, now()).allowed;
  };
  return {
    sender: input.sender,
    webBaseUrl: input.config.ANCS_PUBLIC_WEB_URL ?? input.config.BETTER_AUTH_URL ?? input.fallbackWebBaseUrl,
    productName: input.config.ANCS_PRODUCT_NAME,
    allowRecipient: async (email, kind) => {
      // 限频键里不放明文邮箱（共享存储里只有哈希）
      const allowed = await take(`email:${kind}:${createHash('sha256').update(email).digest('hex').slice(0, 32)}`);
      if (!allowed) input.log.warn({ kind }, '同一收件人短时间内邮件过多，本封未发送');
      return allowed;
    },
    onSendError: (error, kind) => input.log.warn({ kind, driver: input.sender.kind, error: describeSmtpError(error) }, '账号邮件发送失败'),
  };
}

/**
 * 工作区邀请邮件（D-04）：邀请创建成功后寄给被邀请的邮箱。已有账号 → 链接到登录；没有账号且开放注册（invite / open）→ 链接到注册
 * （invite 模式下，持有效工作区邀请的邮箱可以注册）。不等待投递，投递失败只记日志；邀请本身已经生效。
 */
export async function sendWorkspaceInvitationEmail(
  db: NodePgDatabase,
  accounts: AccountsDeps | undefined,
  input: { workspaceId: string; email: string; locale?: AccountEmailLocale | undefined },
): Promise<void> {
  const email = accounts?.email;
  if (email === undefined) return;
  const address = input.email.trim().toLowerCase();
  try {
    const [workspace] = await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, input.workspaceId)).limit(1);
    const [existing] = await db.select({ id: user.id }).from(user).where(eq(user.email, address)).limit(1);
    const url = existing === undefined && accounts?.signupMode !== 'closed'
      ? accountLink(email, 'sign-up', { email: address })
      : accountLink(email, 'sign-in', { email: address });
    void dispatchAccountEmail(email, 'WORKSPACE_INVITATION', address, { url, workspaceName: workspace?.name }, input.locale ?? 'en');
  } catch (error) {
    // 邀请已经生效：寄信前的查询失败只记日志，不让创建邀请的请求失败
    email.onSendError?.(error, 'WORKSPACE_INVITATION');
  }
}
