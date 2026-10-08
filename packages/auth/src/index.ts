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
