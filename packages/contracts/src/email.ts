/**
 * 邮件发送端口（D-04：注册、邮箱验证、找回密码、邀请）。
 *
 * - 业务层只交一封已经排好版的邮件（收件人、主题、纯文本 + HTML）；发信驱动由进程入口按配置装配：
 *   `smtp`（真实投递，生产用）或 `log`（只在开发环境把邮件打到控制台，便于本机点开链接）。
 * - 邮件里的链接带一次性令牌，属于敏感数据：驱动不得把正文写进生产日志；`log` 驱动在生产启动即失败。
 */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailSender {
  /** 驱动名（smtp / log / 测试替身），只用于日志与能力清单 */
  readonly kind: string;
  send(message: EmailMessage): Promise<void>;
}
