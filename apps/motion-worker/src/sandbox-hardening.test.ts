import { describe, expect, it } from 'vitest';
import { analyzeMotionCode } from './analysis.ts';
import { sandboxEnv } from './sandbox.ts';

/**
 * 2026-10 外部评审核实后的加固回归：
 * ① 沙箱子进程**不得**继承宿主环境（库连接串/密钥一律不进未受信代码所在进程）；
 * ② 静态分析补上宿主 realm 逃逸写法（此前只覆盖 `['constructor']` 形式，漏了 `.constructor`）。
 */
describe('Motion 沙箱加固：环境变量白名单', () => {
  it('不继承数据库连接串、会话密钥、平台密钥与对象存储凭据', () => {
    const env = sandboxEnv({
      PATH: '/usr/bin',
      DATABASE_URL: 'postgres://user:pw@host/db',
      BETTER_AUTH_SECRET: 'super-secret',
      ANCS_CREDENTIAL_KEYS: 'v1:xxx',
      PLATFORM_PROVIDER_KEYS: '{"openai":"sk-live"}',
      OBJECT_STORAGE_SECRET_ACCESS_KEY: 's3-secret',
      ANCS_VOICE_SESSION_SECRET: 'voice-secret',
      KMS_KEY_ID: 'kms-1',
    });
    expect(Object.keys(env).sort()).toEqual(['NODE_OPTIONS', 'PATH']);
    expect(env['PATH']).toBe('/usr/bin');
    expect(env['NODE_OPTIONS']).toBe('');
  });

  it('保留 Node 启动必需的平台变量，但绝不透传任何 *_KEY / *_SECRET / *_URL', () => {
    const env = sandboxEnv({
      SystemRoot: 'C:\\Windows', TEMP: 'C:\\Temp', SystemDrive: 'C:',
      REDIS_URL: 'redis://host', ANCS_SANDBOX_ENV_SENTINEL: 'sentinel-value',
    });
    expect(env['SystemRoot']).toBe('C:\\Windows');
    expect(env['TEMP']).toBe('C:\\Temp');
    // 不在白名单里的一律不出现
    expect(env['REDIS_URL']).toBeUndefined();
    expect(env['ANCS_SANDBOX_ENV_SENTINEL']).toBeUndefined();
    expect(env['SystemDrive']).toBeUndefined();
  });
});

describe('Motion 沙箱加固：静态分析覆盖宿主 realm 逃逸写法', () => {
  const rejected = (code: string) => {
    const result = analyzeMotionCode(code);
    expect(result.ok).toBe(false);
  };

  it('点号形式的 .constructor 被拒（此前只覆盖 ["constructor"]）', () => {
    rejected('const f = React.createElement.constructor("return process")();');
    rejected('const g = ({}).constructor;');
  });

  it('Reflect.construct / setPrototypeOf 等反射逃逸被拒', () => {
    rejected('const F = Reflect.construct(Object.constructor, ["return process"]);');
    rejected('Object.setPrototypeOf(payload, null);');
  });

  it('原有的下标记法与 __proto__ 仍被拒（不回归）', () => {
    rejected('const f = React["constructor"]("return process")();');
    rejected('obj.__proto__.polluted = 1;');
  });

  it('正常动效代码不受影响（不误伤）', () => {
    const result = analyzeMotionCode(
      'export default function Motion({ frame }) { const t = frame / 30; return React.createElement("div", { style: { opacity: t } }); }',
    );
    expect(result.ok).toBe(true);
  });
});
