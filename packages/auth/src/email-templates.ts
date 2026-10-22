import type { AccountEmailLocale, EmailMessage } from '@ancs/contracts';

/**
 * 账号邮件模板（D-04；中英双语，按请求时的界面语言选）。
 *
 * 只放纯文本与最简 HTML（不加载外部图片、不带追踪像素）；所有插入值都经过 HTML 转义。
 * 链接里的一次性令牌只出现在邮件里，绝不写进日志。
 */

export type AccountEmailKind = 'VERIFY_EMAIL' | 'RESET_PASSWORD' | 'ACCOUNT_EXISTS' | 'SIGNUP_INVITATION' | 'WORKSPACE_INVITATION';

export interface AccountEmailContent {
  productName: string;
  /** 收件人称呼（可能为空：如邀请时还没有账号） */
  name?: string | undefined;
  /** 邮件里唯一的行动链接 */
  url: string;
  /** 第二个链接（如"已有账号"邮件里的找回密码） */
  secondaryUrl?: string | undefined;
  /** 工作区邀请：工作区名 */
  workspaceName?: string | undefined;
}

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

interface Copy {
  subject: string;
  greeting: string;
  lines: string[];
  action: string;
  footer: string;
  secondary?: { label: string; url: string };
}

function copyFor(kind: AccountEmailKind, locale: AccountEmailLocale, content: AccountEmailContent): Copy {
  const product = content.productName;
  const zh = locale === 'zh-CN';
  const name = content.name?.trim();
  const greeting = zh ? (name ? `${name}，你好：` : '你好：') : (name ? `Hi ${name},` : 'Hi,');
  switch (kind) {
    case 'VERIFY_EMAIL':
      return zh
        ? { subject: `验证你的 ${product} 邮箱`, greeting, lines: [`点下面的按钮确认这是你的邮箱，确认后就能开始使用 ${product}。`, '链接 24 小时内有效。'], action: '验证邮箱', footer: '如果不是你注册的，忽略这封邮件即可，不会创建可用的账号。' }
        : { subject: `Verify your ${product} email`, greeting, lines: [`Confirm this is your email address to start using ${product}.`, 'The link works for 24 hours.'], action: 'Verify email', footer: "If you didn't sign up, you can ignore this email. No usable account will be created." };
    case 'RESET_PASSWORD':
      return zh
        ? { subject: `重设 ${product} 密码`, greeting, lines: ['有人请求重设你的密码。点下面的按钮设一个新密码。', '链接 1 小时内有效，只能用一次；重设后其他设备会被退出登录。'], action: '设置新密码', footer: '如果不是你本人操作，忽略这封邮件即可，密码不会改变。' }
        : { subject: `Reset your ${product} password`, greeting, lines: ['Someone asked to reset your password. Use the button below to choose a new one.', 'The link works once, for 1 hour. Resetting signs you out on other devices.'], action: 'Choose a new password', footer: "If this wasn't you, ignore this email. Your password stays the same." };
    case 'ACCOUNT_EXISTS':
      return zh
        ? { subject: `你已经有 ${product} 账号了`, greeting, lines: ['有人用这个邮箱尝试注册，但这个邮箱已经有账号。', '直接登录即可；忘了密码可以重设。'], action: '登录', footer: '如果不是你本人操作，忽略这封邮件即可，你的账号不受影响。', secondary: { label: '重设密码', url: content.secondaryUrl ?? content.url } }
        : { subject: `You already have a ${product} account`, greeting, lines: ['Someone tried to sign up with this email, but it already has an account.', 'Just sign in. If you forgot your password, you can reset it.'], action: 'Sign in', footer: "If this wasn't you, ignore this email. Your account is unaffected.", secondary: { label: 'Reset password', url: content.secondaryUrl ?? content.url } };
    case 'SIGNUP_INVITATION':
      return zh
        ? { subject: `邀请你试用 ${product}`, greeting, lines: [`你收到了 ${product} 内测邀请：和一位 AI 剪辑师一起剪视频。`, '用收到这封邮件的邮箱注册即可。'], action: '创建账号', footer: '如果你不认识发件人，忽略这封邮件即可。' }
        : { subject: `You're invited to try ${product}`, greeting, lines: [`You've been invited to the ${product} beta: edit videos together with an AI editor.`, 'Sign up with the email address this message was sent to.'], action: 'Create your account', footer: "If you weren't expecting this, you can ignore it." };
    case 'WORKSPACE_INVITATION': {
      const workspace = content.workspaceName ?? product;
      return zh
        ? { subject: `邀请你加入「${workspace}」`, greeting, lines: [`你被邀请加入 ${product} 工作区「${workspace}」。`, '用收到这封邮件的邮箱登录或注册，然后接受邀请。邀请 14 天内有效。'], action: '查看邀请', footer: '如果你不认识邀请人，忽略这封邮件即可。' }
        : { subject: `You're invited to join "${workspace}"`, greeting, lines: [`You've been invited to the ${product} workspace "${workspace}".`, 'Sign in or sign up with the email address this message was sent to, then accept the invitation. It expires in 14 days.'], action: 'View invitation', footer: "If you don't know who sent this, you can ignore it." };
    }
  }
}

/** 渲染一封账号邮件（主题 + 纯文本 + HTML）。 */
export function renderAccountEmail(kind: AccountEmailKind, locale: AccountEmailLocale, to: string, content: AccountEmailContent): EmailMessage {
  const copy = copyFor(kind, locale, content);
  const text = [
    copy.greeting,
    '',
    ...copy.lines,
    '',
    `${copy.action}: ${content.url}`,
    ...(copy.secondary === undefined ? [] : [`${copy.secondary.label}: ${copy.secondary.url}`]),
    '',
    copy.footer,
    '',
    `— ${content.productName}`,
  ].join('\n');
  const button = (label: string, url: string, primary: boolean): string =>
    `<a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 18px;border-radius:999px;text-decoration:none;font-weight:600;${primary ? 'background:#111;color:#fff' : 'border:1px solid #ccc;color:#111'}">${escapeHtml(label)}</a>`;
  const html = [
    '<!doctype html><html><body style="margin:0;padding:24px;background:#f6f6f4;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111">',
    '<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;padding:28px">',
    `<p style="margin:0 0 16px">${escapeHtml(copy.greeting)}</p>`,
    ...copy.lines.map((line) => `<p style="margin:0 0 12px;line-height:1.5">${escapeHtml(line)}</p>`),
    `<p style="margin:20px 0">${button(copy.action, content.url, true)}${copy.secondary === undefined ? '' : `&nbsp;&nbsp;${button(copy.secondary.label, copy.secondary.url, false)}`}</p>`,
    `<p style="margin:0 0 12px;font-size:13px;color:#555;word-break:break-all">${escapeHtml(content.url)}</p>`,
    `<p style="margin:16px 0 0;font-size:13px;color:#555">${escapeHtml(copy.footer)}</p>`,
    `<p style="margin:16px 0 0;font-size:13px;color:#555">— ${escapeHtml(content.productName)}</p>`,
    '</div></body></html>',
  ].join('');
  return { to, subject: copy.subject, text, html };
}
