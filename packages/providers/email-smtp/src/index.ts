import { createTransport, type Transporter } from 'nodemailer';
import type { EmailMessage, EmailSender } from '@ancs/contracts';

/**
 * 发信驱动（D-04）。
 *
 * - `SmtpEmailSender`：经 SMTP 投递（AWS SES、Postmark、Resend、SendGrid、Mailgun 等都提供 SMTP 入口）；
 *   连接、问候、读写各有超时，投递失败抛错由调用方记日志（错误描述不含地址里的密码）；
 * - `LogEmailSender`：开发用，把邮件打到控制台方便点开链接；正文含一次性令牌，**生产禁用**（入口配置校验拦截）。
 */

export interface SmtpEmailOptions {
  /** smtp(s)://用户名:密码@主机:端口 */
  url: string;
  /** 发件人，如 "ANCS <no-reply@example.com>" */
  from: string;
  /** 连接超时（毫秒；缺省 10 秒） */
  connectionTimeoutMs?: number;
  /** 读写超时（毫秒；缺省 20 秒） */
  socketTimeoutMs?: number;
}

export class SmtpEmailSender implements EmailSender {
  readonly kind = 'smtp';
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(options: SmtpEmailOptions) {
    this.from = options.from;
    this.transport = createTransport({
      url: options.url,
      connectionTimeout: options.connectionTimeoutMs ?? 10_000,
      greetingTimeout: options.connectionTimeoutMs ?? 10_000,
      socketTimeout: options.socketTimeoutMs ?? 20_000,
    });
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, to: message.to, subject: message.subject, text: message.text, html: message.html });
  }

  /** 启动自检：能连上、能登录（不发信） */
  async verify(): Promise<void> {
    await this.transport.verify();
  }

  close(): void {
    this.transport.close();
  }
}

/** SMTP 错误的安全描述（只取错误码与服务器响应码，不含地址与凭据） */
export function describeSmtpError(error: unknown): string {
  const failure = error as { code?: unknown; responseCode?: unknown; command?: unknown } | null;
  const parts = [
    typeof failure?.code === 'string' ? failure.code : 'ERROR',
    typeof failure?.responseCode === 'number' ? `SMTP ${String(failure.responseCode)}` : null,
    typeof failure?.command === 'string' ? `at ${failure.command}` : null,
  ].filter((part): part is string => part !== null);
  return parts.join(' ');
}

/** 开发用：邮件打到控制台（含链接，只在开发环境装配）。 */
export class LogEmailSender implements EmailSender {
  readonly kind = 'log';
  constructor(private readonly write: (line: string) => void = (line) => console.info(line)) {}

  async send(message: EmailMessage): Promise<void> {
    this.write(`[email:log] to=${message.to} subject=${message.subject}\n${message.text}`);
  }
}
