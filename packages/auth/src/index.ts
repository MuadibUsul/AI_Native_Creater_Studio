export { createAuth } from './auth-core.js';
export type { AuthInstance, AuthCoreOptions } from './auth-core.js';
export {
  assertRegisteredClient,
  base64UrlSha256,
  createAuthorizationCode,
  DEFAULT_NATIVE_TOKEN_CONFIG,
  exchangeAuthorizationCode,
  findRegisteredClient,
  nativeClientSchema,
  parseNativeClients,
  refreshTokenPair,
  revokeFamily,
  revokeRefreshToken,
  sha256Hex,
  verifyAccessToken,
} from './native-tokens.js';
export type {
  AuthorizationCodeInput,
  NativeAccessTokenInfo,
  NativeClient,
  NativeTokenConfig,
  TokenDeps,
} from './native-tokens.js';
export { findUserById, resolveAuthContext } from './session.js';
export type { AuthContext, RequestAuthHeaders, SessionDeps } from './session.js';
export { DEFAULT_OPS_SESSION_POLICY, eligibleOpsPrincipal, activateOpsSession, resolveOpsSession, revokeOwnOpsSession, assertOpsReauthAllowed, recordOpsReauthFailure, markOpsReauthenticated } from './ops.js';
export type { OpsSessionPolicy, OpsAuthDeps } from './ops.js';
export { OPS_PERMISSION_POLICY_VERSION, OPS_PERMISSION_POLICY_HASH, OPS_PERMISSION_RULES, publishedOpsPolicyMatches, decideOpsPermission } from './ops-permissions.js';
export { assessEmergencyGrant } from './ops-emergency.js';
export {
  authorizeWorkspace,
  getMembership,
  roleHasCapability,
  ROLE_CAPABILITIES,
  WORKSPACE_CAPABILITIES,
} from './authorization.js';
export type { Membership, WorkspaceCapability } from './authorization.js';
export {
  addMember,
  createWorkspace,
  getWorkspace,
  listMembers,
  listWorkspaces,
  removeMember,
  setWorkspacePrivacyTier,
  updateMemberRole,
  updateWorkspace,
} from './workspaces.js';
export type { WorkspaceServiceDeps } from './workspaces.js';
export { ApiFailure } from '@ancs/contracts';
export { createInternalUser } from './internal-users.js';
export type { CreateInternalUserInput, CreatedInternalUser } from './internal-users.js';
// 账号自助（D-04）：注册、验证邮箱、找回密码、平台内测邀请
export {
  authApiErrorCode,
  createSignupInvitation,
  hasSignupInvitation,
  isAuthApiError,
  listSignupInvitations,
  normalizeEmail,
  requestPasswordReset,
  resendVerificationEmail,
  resetPasswordWithToken,
  revokeSignupInvitation,
  signUpWithEmail,
  SIGNUP_INVITATION_TTL_DAYS,
  verifyEmailToken,
} from './accounts.js';
export type { AccountDeps, SignupInvitationRow } from './accounts.js';
export { accountLink, dispatchAccountEmail, withAccountEmailContext } from './account-email.js';
export type { AccountEmailOptions } from './account-email.js';
export { renderAccountEmail } from './email-templates.js';
export type { AccountEmailContent, AccountEmailKind } from './email-templates.js';
export { EMAIL_VERIFICATION_TTL_SECONDS, RESET_PASSWORD_TTL_SECONDS } from './auth-core.js';
