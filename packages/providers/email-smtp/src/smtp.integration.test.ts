import type { AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeSmtpError, LogEmailSender, SmtpEmailSender } from './index.js';

/**
 * SMTP 驱动对真实 SMTP 协议的验收：进程内起一个要求登录的 SMTP 服务（smtp-server），
 * 驱动按 URL 连接、AUTH 登录、投递，服务端收到的原文里有主题、纯文本与 HTML 两部分。
 * 这只证明协议与驱动正确；真实服务商（SES / Postmark 等）的投递待所有者提供账号后实测。
 */

interface Received { from: string; to: string[]; raw: string; user: string | undefined }
const received: Received[] = [];
let server: SMTPServer;
let port: number;

beforeAll(async () => {
  server = new SMTPServer({
    secure: false,
    authOptional: false,
    allowInsecureAuth: true,
    disabledCommands: ['STARTTLS'],
    onAuth(auth, _session, callback) {
      if (auth.username === 'mailer' && auth.password === 'smtp-test-password') callback(null, { user: auth.username }); // secrets:check-ignore：测试专用假密码
      else callback(new Error('Invalid username or password'));
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        received.push({
          from: session.envelope.mailFrom === false ? '' : session.envelope.mailFrom.address,
          to: session.envelope.rcptTo.map((address) => address.address),
          raw: Buffer.concat(chunks).toString('utf8'),
          user: typeof session.user === 'string' ? session.user : undefined,
        });
        callback();
      });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('SMTP 发信驱动', () => {
  it('登录后投递：信封发件人 / 收件人正确，正文同时有纯文本与 HTML，中文主题按 RFC 2047 编码', async () => {
    const sender = new SmtpEmailSender({ url: `smtp://mailer:smtp-test-password@127.0.0.1:${String(port)}`, from: 'ANCS <no-reply@example.com>' }); // secrets:check-ignore：测试专用假密码
    await sender.verify();
    await sender.send({ to: 'new.user@example.com', subject: '验证你的 ANCS 邮箱', text: 'Verify: https://studio.example.com/verify-email?token=abc', html: '<p>Verify</p>' });
    sender.close();
    const message = received.at(-1)!;
    expect(message.user).toBe('mailer');
    expect(message.from).toBe('no-reply@example.com');
    expect(message.to).toEqual(['new.user@example.com']);
    expect(message.raw).toMatch(/^Subject: =\?UTF-8\?/m);
    expect(message.raw).toContain('Content-Type: text/plain');
    expect(message.raw).toContain('Content-Type: text/html');
    expect(message.raw).toContain('https://studio.example.com/verify-email?token=abc');
  });

  it('密码错误：投递失败，错误描述不含地址与密码', async () => {
    const sender = new SmtpEmailSender({ url: `smtp://mailer:wrong-password-0000@127.0.0.1:${String(port)}`, from: 'no-reply@example.com' }); // secrets:check-ignore：错误密码夹具
    const failure = await sender.send({ to: 'a@example.com', subject: 's', text: 't', html: '<p>t</p>' }).then(() => null, (error: unknown) => error);
    sender.close();
    expect(failure).not.toBeNull();
    const description = describeSmtpError(failure);
    expect(description).toContain('EAUTH');
    expect(description).not.toContain('wrong-password');
    expect(description).not.toContain('127.0.0.1');
  });

  it('连不上：在超时内失败', async () => {
    const sender = new SmtpEmailSender({ url: 'smtp://mailer:x@127.0.0.1:1', from: 'no-reply@example.com', connectionTimeoutMs: 2000 });
    await expect(sender.verify()).rejects.toThrow();
    sender.close();
  });

  it('log 驱动只写到给定输出（开发用）', async () => {
    const lines: string[] = [];
    await new LogEmailSender((line) => lines.push(line)).send({ to: 'a@example.com', subject: 'Hello', text: 'Body https://x', html: '<p>Body</p>' });
    expect(lines).toEqual(['[email:log] to=a@example.com subject=Hello\nBody https://x']);
  });
});
