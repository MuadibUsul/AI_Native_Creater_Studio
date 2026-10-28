import { createSignupInvitation, listSignupInvitations, revokeSignupInvitation } from '@ancs/auth';
import { crossCheckEmailEnv, formatEnvFailure, signupInviteCliEnvSchema, validateEnv } from '@ancs/contracts';
import { createDb } from '@ancs/db';
import { describeSmtpError, SmtpEmailSender } from '@ancs/providers-email-smtp';
import { createAccountEmailOptions, createEmailSender } from '../plugins/email.js';

/**
 * 内测邀请（D-04 invite 模式：只有收到邀请的邮箱能注册）：
 *
 *   pnpm invite:signup add someone@example.com [--note "来自哪里"] [--by "谁邀请的"] [--locale zh-CN|en]
 *   pnpm invite:signup list
 *   pnpm invite:signup revoke someone@example.com
 *
 * add：同一邮箱已有有效邀请时只顺延有效期（30 天）；配置了发信（ANCS_EMAIL_DRIVER）就同时寄出邀请邮件。
 * 退出码：0 = 完成；1 = 参数 / 配置错误或邮件没寄出（邀请本身已生效时会说明）。
 */

const USAGE = '用法：invite:signup add <email> [--note 文字] [--by 邀请人] [--locale zh-CN|en] | list | revoke <email>';

function parse(argv: readonly string[]): { command: string; email?: string; flags: Map<string, string> } {
  const tokens = argv.filter((token) => token !== '--');
  const [command, ...rest] = tokens;
  const flags = new Map<string, string>();
  let email: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (token.startsWith('--')) {
      const value = rest[index + 1];
      if (value === undefined) throw new Error(`参数 ${token} 缺少值`);
      flags.set(token.slice(2), value);
      index += 1;
    } else if (email === undefined) {
      email = token;
    } else {
      throw new Error(`多余的参数 "${token}"`);
    }
  }
  if (command === undefined) throw new Error(USAGE);
  return { command, ...(email === undefined ? {} : { email }), flags };
}

let args: ReturnType<typeof parse>;
try {
  args = parse(process.argv.slice(2));
} catch (error) {
  console.error(`[invite:signup] ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
  process.exit(1);
}

const envResult = validateEnv(signupInviteCliEnvSchema, process.env);
const issues = envResult.value === null ? envResult.issues : [...envResult.issues, ...crossCheckEmailEnv(envResult.value)];
if (!envResult.ok || envResult.value === null || issues.length > 0) {
  console.error(formatEnvFailure('invite:signup', issues));
  process.exit(1);
}
const config = envResult.value;
const handle = createDb(config.DATABASE_URL);
let exitCode = 0;
try {
  if (args.command === 'add') {
    if (args.email === undefined || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(args.email)) throw new Error(`需要一个邮箱地址。${USAGE}`);
    const locale = args.flags.get('locale');
    if (locale !== undefined && locale !== 'zh-CN' && locale !== 'en') throw new Error('--locale 只能是 zh-CN 或 en');
    const sender = createEmailSender(config);
    let sendFailure: string | null = null;
    const email = sender === null ? undefined : {
      ...createAccountEmailOptions({ config, sender, fallbackWebBaseUrl: 'http://localhost:3000', log: { warn: () => undefined } }),
      allowRecipient: undefined,
      onSendError: (error: unknown) => { sendFailure = describeSmtpError(error); },
    };
    const { invitation, created } = await createSignupInvitation(handle.db, {
      email: args.email,
      invitedBy: args.flags.get('by'),
      note: args.flags.get('note'),
      ...(locale === undefined ? {} : { locale }),
    }, email);
    if (sender instanceof SmtpEmailSender) sender.close();
    console.log(`[invite:signup] ${created ? '已邀请' : '已顺延有效期'} ${invitation.email}（有效期至 ${invitation.expiresAt.toISOString()}）`);
    if (sender === null) console.log('[invite:signup] 未配置发信：没有寄出邀请邮件，请自行把注册链接（网站地址 /sign-up）告诉对方');
    else if (sendFailure !== null) {
      console.error(`[invite:signup] 邀请已生效，但邀请邮件没寄出（${String(sendFailure)}）——检查发信配置后可重新执行 add`);
      exitCode = 1;
    } else console.log(`[invite:signup] 邀请邮件已发出（${sender.kind}）`);
  } else if (args.command === 'list') {
    const rows = await listSignupInvitations(handle.db);
    if (rows.length === 0) console.log('[invite:signup] 还没有邀请');
    for (const row of rows) {
      console.log([row.status.padEnd(8), row.email, `到期 ${row.expiresAt.toISOString().slice(0, 10)}`, row.invitedBy ?? '', row.note ?? ''].join('  ').trimEnd());
    }
  } else if (args.command === 'revoke') {
    if (args.email === undefined) throw new Error(`需要一个邮箱地址。${USAGE}`);
    const revoked = await revokeSignupInvitation(handle.db, args.email);
    console.log(revoked ? `[invite:signup] 已撤销 ${args.email.trim().toLowerCase()} 的邀请（已注册的账号不受影响）` : `[invite:signup] ${args.email} 没有有效邀请`);
  } else {
    throw new Error(USAGE);
  }
} catch (error) {
  console.error(`[invite:signup] ${error instanceof Error ? error.message : String(error)}`);
  exitCode = 1;
} finally {
  await handle.close().catch(() => undefined);
}
process.exit(exitCode);
