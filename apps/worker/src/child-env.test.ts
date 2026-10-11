import { describe, expect, it } from 'vitest';
import { MEDIA_CHILD_ENV, childProcessEnv } from './child-env.js';

describe('childProcessEnv：子进程环境白名单', () => {
  const host = {
    PATH: '/usr/bin',
    HOME: '/srv/worker-home',
    DATABASE_URL: 'postgres://u:p@db/ancs',
    BETTER_AUTH_SECRET: 'x'.repeat(32),
    ANCS_STORAGE_SECRET: 'y'.repeat(32),
    ANCS_CREDENTIAL_KEYS: 'v1:abc',
    PLATFORM_PROVIDER_KEYS: '{"openai":"sk-live"}',
    REDIS_URL: 'redis://cache:6379',
    NODE_OPTIONS: '--require ./inject.js',
    REMOTION_BROWSER_EXECUTABLE: '/opt/chrome/headless_shell',
    ANCS_FFMPEG_PATH: '/usr/bin/ffmpeg',
  };

  it('只放行平台必需项与声明的键/前缀；连接串、密钥与 NODE_OPTIONS 不进入子进程', () => {
    const env = childProcessEnv(host, MEDIA_CHILD_ENV);
    expect(env).toEqual({
      NODE_OPTIONS: '',
      PATH: '/usr/bin',
      HOME: '/srv/worker-home',
      REMOTION_BROWSER_EXECUTABLE: '/opt/chrome/headless_shell',
      ANCS_FFMPEG_PATH: '/usr/bin/ffmpeg',
    });
  });

  it('未声明额外项时只剩平台必需项', () => {
    expect(Object.keys(childProcessEnv(host)).sort()).toEqual(['HOME', 'NODE_OPTIONS', 'PATH']);
  });
});
