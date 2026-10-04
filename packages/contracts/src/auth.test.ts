import { describe, expect, it } from 'vitest';
import {
  errorEnvelope,
  nativeAuthorizeQuerySchema,
  signInRequestSchema,
  tokenRequestSchema,
  tokenResponseSchema,
} from './index.js';

describe('认证契约（P01-02）', () => {
  it('登录请求校验：合法通过；短密码/非法邮箱被拒', () => {
    expect(signInRequestSchema.safeParse({ email: 'a@b.co', password: '12345678' }).success).toBe(true);
    expect(signInRequestSchema.safeParse({ email: 'a@b.co', password: 'short' }).success).toBe(false);
    expect(signInRequestSchema.safeParse({ email: 'not-an-email', password: '12345678' }).success).toBe(false);
  });

  it('PKCE 授权查询：S256 默认值生效；非 base64url 挑战被拒', () => {
    const parsed = nativeAuthorizeQuerySchema.parse({
      responseType: 'code',
      clientId: 'ancs-desktop',
      redirectUri: 'ancs://auth/callback',
      codeChallenge: 'x'.repeat(43),
      state: 'st_1',
    });
    expect(parsed.codeChallengeMethod).toBe('S256');

    expect(
      nativeAuthorizeQuerySchema.safeParse({
        responseType: 'code',
        clientId: 'c',
        redirectUri: 'r',
        codeChallenge: 'short-challenge',
        state: 's',
      }).success,
    ).toBe(false);
  });

  it('token 请求为判别联合：两种 grant 各自校验', () => {
    const codeGrant = tokenRequestSchema.parse({
      grantType: 'authorization_code',
      clientId: 'ancs-desktop',
      code: 'ancs_ac_abc',
      codeVerifier: 'v'.repeat(43),
    });
    expect(codeGrant.grantType).toBe('authorization_code');

    const refreshGrant = tokenRequestSchema.parse({
      grantType: 'refresh_token',
      clientId: 'ancs-desktop',
      refreshToken: 'ancs_rt_abc',
    });
    expect(refreshGrant.grantType).toBe('refresh_token');

    expect(
      tokenRequestSchema.safeParse({ grantType: 'client_credentials', clientId: 'c' }).success,
    ).toBe(false);
    // authorization_code 缺 codeVerifier → 拒绝
    expect(
      tokenRequestSchema.safeParse({ grantType: 'authorization_code', clientId: 'c', code: 'ancs_ac_x' }).success,
    ).toBe(false);
  });

  it('token 响应形状与 errorEnvelope 辅助函数', () => {
    const response = {
      tokenType: 'Bearer',
      accessToken: 'ancs_at_x',
      expiresIn: 900,
      refreshToken: 'ancs_rt_y',
      refreshExpiresIn: 2592000,
    };
    expect(tokenResponseSchema.parse(response)).toEqual(response);

    const envelope = errorEnvelope('INVALID_GRANT', 'authorization code is invalid or already used', 'req_1');
    expect(envelope.error.code).toBe('INVALID_GRANT');
    expect(envelope.error.details).toEqual({});
  });
});
