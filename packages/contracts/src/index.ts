// 常量
export { API_PREFIX, V1_DEFAULT_FORMAT, STANDARD_SCENE_TYPES } from './constants.js';

// 公共基础
export { opaqueIdSchema } from './common/ids.js';
export type { OpaqueId } from './common/ids.js';
export { isoDateTimeSchema, isoDateOrDateTimeSchema, videoMsSchema, durationMsSchema } from './common/time.js';
export type { IsoDateTime, VideoMs } from './common/time.js';
export { revisionSchema } from './common/revision.js';
export type { Revision } from './common/revision.js';
export { moneySchema, creditsSchema } from './common/money.js';
export type { Money, Credits } from './common/money.js';
export { pageRequestSchema, pageResponseSchema } from './common/pagination.js';
export type { PageRequest } from './common/pagination.js';
export { eventEnvelopeSchema, EVENT_TYPES } from './common/events.js';
export type { EventEnvelope } from './common/events.js';
export { CLIENT_TYPES, clientTypeSchema, clientVersionSchema, requestIdSchema, idempotencyKeySchema } from './common/http.js';
export type { ClientType } from './common/http.js';
export { errorEnvelopeSchema, ERROR_CODES, versionConflictDetailsSchema, errorEnvelope } from './common/error.js';
export type { ErrorEnvelope, ErrorCode, VersionConflictDetails } from './common/error.js';
export { ApiFailure } from './common/failure.js';

// 领域契约
export {
  sceneGraphSchema,
  sceneSchema,
  sceneStatusSchema,
  sceneFormatSchema,
  sceneTransitionSchema,
  providerRequirementSchema,
  sourceBindingSchema,
  dataBindingSchema,
  assetBindingSchema,
  captionSchema,
  captionWordSchema,
  audioTrackSchema,
  AUDIO_TRACK_KINDS,
  overlaySchema,
  sourceReferenceSchema,
  channelSnapshotSchema,
  identitySnapshotSchema,
  sceneTimelineSchema,
} from './scene-graph.js';
export type {
  SceneGraph,
  Scene,
  SceneStatus,
  Caption,
  AudioTrack,
  ProviderRequirement,
} from './scene-graph.js';

export {
  contentDocumentSchema,
  contentBlockSchema,
  claimSchema,
  citationSchema,
  contentTableSchema,
  contentFigureSchema,
  contentAttachmentSchema,
  contentExtractionsSchema,
  extractedEntitySchema,
  causalRelationSchema,
  timelineEventSchema,
  geoRelationSchema,
  numericFactSchema,
  CONTENT_BLOCK_TYPES,
  CLAIM_FACTUALITIES,
  ENTITY_KINDS,
} from './content.js';
export type { ContentDocument, ContentBlock, Claim, ContentExtractions } from './content.js';

export { sourceSnapshotSchema, SNAPSHOT_KINDS } from './sources.js';
export type { SourceSnapshot } from './sources.js';

export {
  structuredDatasetSchema,
  datasetSeriesSchema,
  datasetPointSchema,
  DATASET_POINT_ACCURACIES,
} from './datasets.js';
export type { StructuredDataset, DatasetSeries } from './datasets.js';

export {
  editRequestSchema,
  editOperationSchema,
  EDIT_OPERATION_TYPES,
  sceneDraftSchema,
  projectChangesSchema,
  sceneChangesSchema,
  updateProjectOperationSchema,
  updateScriptOperationSchema,
  insertSceneOperationSchema,
  updateSceneOperationSchema,
  deleteSceneOperationSchema,
  duplicateSceneOperationSchema,
  splitSceneOperationSchema,
  reorderScenesOperationSchema,
  replaceAssetOperationSchema,
  updateCaptionOperationSchema,
  updateAudioTrackOperationSchema,
  setSceneLockOperationSchema,
  restoreSceneOperationSchema,
  restoreProjectVersionOperationSchema,
} from './edits.js';
export type { EditRequest, EditOperation, EditOperationType, ProjectChanges, SceneChanges } from './edits.js';

// 认证契约（P01-02）
export {
  authUserSchema,
  sessionInfoSchema,
  signInRequestSchema,
  signInResponseSchema,
  nativeAuthorizeQuerySchema,
  authorizationCodeGrantSchema,
  refreshTokenGrantSchema,
  tokenRequestSchema,
  tokenResponseSchema,
  revokeTokenRequestSchema,
  AUTH_METHODS,
} from './auth.js';
export type {
  AuthUser,
  SessionInfo,
  SignInResponse,
  TokenRequest,
  TokenResponse,
  RevokeTokenRequest,
} from './auth.js';

// 编辑历史与版本契约（P02-02/P02-03 / §23、§24）
export {
  EDIT_ACTOR_TYPES,
  editEventSchema,
  VERSION_REASONS,
  versionReasonSchema,
  projectVersionSnapshotSchema,
  projectVersionSchema,
  projectVersionDetailSchema,
  createProjectVersionRequestSchema,
} from './history.js';
export type {
  EditEvent,
  VersionReason,
  ProjectVersionSnapshot,
  ProjectVersion,
  ProjectVersionDetail,
} from './history.js';

// Project / Scene 契约（P02-01 / §22.3、§19.1）
export {
  PROJECT_STATUSES,
  projectStatusSchema,
  PROJECT_SOURCE_TYPES,
  projectSourceTypeSchema,
  projectSchema,
  projectChannelSnapshotSchema,
  projectDetailSchema,
  createProjectRequestSchema,
  createSceneRequestSchema,
  createSceneResponseSchema,
  editResponseSchema,
} from './projects.js';
export type {
  ProjectStatus,
  ProjectSourceType,
  Project,
  ProjectChannelSnapshot,
  ProjectDetail,
  CreateProjectRequest,
  CreateSceneRequest,
  CreateSceneResponse,
  EditResponse,
} from './projects.js';

// 生成适配器契约（P03-07；真实与 Mock Provider 共用）
export {
  PROVIDER_JOB_STATES,
  providerJobStateSchema,
  generationSubmitRequestSchema,
  ProviderRateLimitedError,
  ProviderSubmissionUnknownError,
} from './generation.js';
export type {
  ProviderJobState,
  GenerationSubmitRequest,
  GenerationSubmitResult,
  GenerationStatusResult,
  GenerationCancelResult,
  GenerationProvider,
} from './generation.js';

// Provider 结果回收与 Webhook 契约（P03-06 / §30、§31、§33.4）
export {
  WEBHOOK_VERIFICATION_STATUSES,
  webhookVerificationStatusSchema,
  webhookEventSchema,
  providerCallbackSchema,
  resultCollectionSchema,
  collectRequestSchema,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
  WEBHOOK_REJECTION_REASONS,
} from './results.js';
export type {
  WebhookVerificationStatus,
  WebhookEvent,
  ProviderCallback,
  ResultCollection,
  CollectRequest,
  ResultFetcher,
  WebhookVerifier,
} from './results.js';

// 账本与预算契约（P03-05 / 规范 §35.1、§68）
export {
  LEDGER_ENTRY_TYPES,
  ledgerEntryTypeSchema,
  ledgerEntrySchema,
  HOLD_STATUSES,
  holdStatusSchema,
  creditHoldSchema,
  BUDGET_PERIODS,
  budgetPeriodSchema,
  workspaceBudgetSchema,
  upsertBudgetRequestSchema,
  billingStatusSchema,
  topUpRequestSchema,
  PROVIDER_GENERATION_STATUSES,
  providerGenerationStatusSchema,
  providerGenerationSchema,
  recordGenerationRequestSchema,
  BUDGET_REJECTION_REASONS,
} from './billing.js';
export type {
  LedgerEntryType,
  LedgerEntry,
  HoldStatus,
  CreditHold,
  BudgetPeriod,
  WorkspaceBudget,
  UpsertBudgetRequest,
  BillingStatus,
  TopUpRequest,
  ProviderGenerationStatus,
  ProviderGeneration,
  RecordGenerationRequest,
} from './billing.js';

// Provider 凭据与路由契约（P03-04 / 规范 §17.2、§17.3）
export {
  CREDENTIAL_MODES,
  credentialModeSchema,
  CREDENTIAL_SELECTION_MODES,
  credentialSelectionModeSchema,
  CONNECTION_STATUSES,
  connectionStatusSchema,
  CONNECTION_TEST_MODES,
  connectionTestModeSchema,
  CONNECTION_TEST_STATUSES,
  connectionTestStatusSchema,
  providerConnectionSchema,
  createConnectionRequestSchema,
  rotateConnectionRequestSchema,
  testConnectionResponseSchema,
  workspaceProviderSettingSchema,
  upsertWorkspaceProviderSettingRequestSchema,
  routeRejectionSchema,
  providerRouteDecisionSchema,
  encryptedSecretSchema,
} from './credentials.js';
export type {
  CredentialMode,
  CredentialSelectionMode,
  ConnectionStatus,
  ConnectionTestMode,
  ConnectionTestStatus,
  ProviderConnection,
  CreateConnectionRequest,
  RotateConnectionRequest,
  TestConnectionResponse,
  WorkspaceProviderSetting,
  UpsertWorkspaceProviderSettingRequest,
  ProviderRouteDecision,
  EncryptedSecret,
  CredentialCipher,
  ProviderTestHook,
  PlatformCredentialRegistry,
} from './credentials.js';

// Provider Catalog 契约（P03-03）
export {
  PROVIDER_KINDS,
  providerKindSchema,
  PROVIDER_CAPABILITIES,
  DATA_RETENTION_POLICIES,
  dataRetentionPolicySchema,
  MODEL_STATUSES,
  modelStatusSchema,
  PRICE_UNITS,
  priceUnitSchema,
  priceProfileSchema,
  modelLimitsSchema,
  providerModelSchema,
  providerCatalogEntrySchema,
  providerCatalogSchema,
  modelAvailabilitySchema,
  DEFAULT_MAX_VERIFICATION_AGE_DAYS,
  catalogResponseSchema,
  capabilitySelectionSchema,
  catalogSeedRequestSchema,
  CATALOG_ERROR_REASONS,
} from './providers.js';
export type {
  ProviderKind,
  DataRetentionPolicy,
  ModelStatus,
  PriceUnit,
  PriceProfile,
  ModelLimits,
  ProviderModel,
  ProviderCatalogEntry,
  ProviderCatalog,
  ModelAvailability,
  CatalogResponse,
  CapabilitySelection,
  CatalogSeedRequest,
} from './providers.js';

// 任务契约（P03-01 / 计划 §5.5）
export {
  JOB_STATUSES,
  jobStatusSchema,
  JOB_TERMINAL_STATUSES,
  JOB_SUBMIT_STATES,
  jobSubmitStateSchema,
  jobStageSchema,
  jobSchema,
  jobQueueMessageSchema,
  DEFAULT_QUEUE,
  MAINTENANCE_QUEUE,
} from './jobs.js';
export type { JobStatus, JobSubmitState, Job, JobQueueMessage, JobQueueAdapter } from './jobs.js';

// 事件与通知契约（P02-06 / §34）
export {
  NOTIFICATION_TYPES,
  notificationTypeSchema,
  notificationSchema,
  unreadCountResponseSchema,
  workspaceEventSchema,
  eventCursorSchema,
} from './notifications.js';
export type { NotificationType, Notification, UnreadCountResponse, WorkspaceEvent, EventCursor } from './notifications.js';

// 资产与对象存储契约（P02-04 / §22.5、§26、§27、§51）
export {
  ASSET_TYPES,
  assetTypeSchema,
  ASSET_ORIGINS,
  assetOriginSchema,
  ASSET_STATUSES,
  assetStatusSchema,
  ASSET_VERSION_STATUSES,
  assetVersionStatusSchema,
  ASSET_ROLES,
  assetRoleSchema,
  RETENTION_CLASSES,
  retentionClassSchema,
  RETENTION_TTL_SECONDS,
  ASSET_DEFAULT_RETENTION,
  LICENSE_TYPES,
  licenseMetadataSchema,
  licenseInputSchema,
  assetVersionSchema,
  assetSchema,
  assetDetailSchema,
  MAX_UPLOAD_BYTES,
  createUploadIntentRequestSchema,
  uploadIntentResponseSchema,
  confirmUploadRequestSchema,
  downloadUrlResponseSchema,
  DIRECT_UPLOAD_ASSET_TYPES,
} from './assets.js';
export type {
  AssetType,
  AssetOrigin,
  AssetStatus,
  AssetVersionStatus,
  AssetRole,
  RetentionClass,
  LicenseMetadata,
  Asset,
  AssetDetail,
  AssetVersion,
  CreateUploadIntentRequest,
  CreateUploadIntentInput,
  UploadIntentResponse,
  ConfirmUploadRequest,
  DownloadUrlResponse,
} from './assets.js';
export {
  UPLOAD_URL_TTL_SECONDS,
  DOWNLOAD_URL_TTL_SECONDS,
  MAX_SIGNED_URL_TTL_SECONDS,
  signedUrlPurposeSchema,
  uploadTargetSchema,
  downloadTargetSchema,
  objectProbeSchema,
  storageKeySchema,
} from './storage.js';
export type { SignedUrlPurpose, UploadTarget, DownloadTarget, ObjectProbe, ObjectStorageAdapter } from './storage.js';
export { sniffMimeType, mimeMatches, probeImageDimensions, probeWavDurationMs, ASSET_MIME_ALLOWLIST } from './mime-sniff.js';

// 扩展架构契约（P01-06 / §92）
export {
  PLUGIN_CAPABILITIES,
  pluginCapabilitySchema,
  packManifestSchema,
  contentCoreRefSchema,
  pluginContextSchema,
  outputPlanSchema,
  outputPlanItemSchema,
  ARTIFACT_KINDS,
  artifactSchema,
  validationIssueSchema,
  validationResultSchema,
  HANDOFF_STATES,
  handoffDescriptorSchema,
  capabilityAvailabilitySchema,
  capabilitySnapshotSchema,
  capabilitiesResponseSchema,
} from './extensions.js';
export type {
  PluginCapability,
  PackManifest,
  ContentCoreRef,
  PluginContext,
  OutputPlan,
  Artifact,
  ValidationResult,
  HandoffDescriptor,
  CapabilityAvailability,
  CapabilitySnapshot,
  CapabilitiesResponse,
  OutputPlugin,
} from './extensions.js';

// 发布契约（P01-06 / §42、§90；DEC-06：V1=契约级）
export {
  PUBLISH_CAPABILITY_TIERS,
  publishCapabilityTierSchema,
  DISTRIBUTION_CAPABILITIES,
  distributionCapabilitySchema,
  distributionCapabilitiesSchema,
  PUBLICATION_STATES,
  publicationStatusSchema,
  publicationKeySchema,
  publicationRequestSchema,
  draftTransferResultSchema,
  providerContextSchema,
  authorizationRequestSchema,
  authorizationResultSchema,
  publicationJobSchema,
  updatePublicationRequestSchema,
  analyticsRequestSchema,
  platformAnalyticsSchema,
  revokeRequestSchema,
  distributionProviderRegistrationSchema,
} from './publishing.js';
export type {
  PublishCapabilityTier,
  DistributionCapability,
  DistributionCapabilities,
  PublicationStatus,
  PublicationKey,
  PublicationRequest,
  DraftTransferResult,
  ProviderContext,
  AuthorizationRequest,
  AuthorizationResult,
  PublicationJob,
  UpdatePublicationRequest,
  AnalyticsRequest,
  PlatformAnalytics,
  RevokeRequest,
  DistributionProvider,
  DistributionProviderRegistration,
} from './publishing.js';

// 主题 / Channel / 身份 / SpeechProfile 契约（P01-04）
export { themeTokensSchema, DEFAULT_THEME_TOKENS } from './theme.js';
export type { ThemeTokens } from './theme.js';
export {
  ASPECT_RATIOS,
  SOURCE_DISPLAY_POLICIES,
  AI_BROLL_POLICIES,
  channelStyleDefaultsSchema,
  channelStyleOverrideSchema,
  DEFAULT_CHANNEL_STYLE,
  mergeChannelStyle,
  channelSchema,
  channelStyleVersionSchema,
  channelWithStyleSchema,
  createChannelRequestSchema,
  updateChannelRequestSchema,
} from './channels.js';
export type {
  ChannelStyleDefaults,
  ChannelStyleOverride,
  Channel,
  ChannelStyleVersion,
  ChannelWithStyle,
  CreateChannelRequest,
  UpdateChannelRequest,
} from './channels.js';
export {
  IDENTITY_STATUSES,
  VOICE_CLONE_TYPES,
  VOICE_OWNERSHIP_TYPES,
  VOICE_MANAGED_MODES,
  avatarIdentitySchema,
  voiceIdentitySchema,
  brandIdentitySchema,
  creatorIdentitySchema,
  createCreatorIdentityRequestSchema,
  avatarIdentityUpsertSchema,
  voiceIdentityUpsertSchema,
  brandIdentityUpsertSchema,
  updateCreatorIdentityRequestSchema,
} from './identities.js';
export type {
  AvatarIdentity,
  VoiceIdentity,
  BrandIdentity,
  CreatorIdentity,
  CreateCreatorIdentityRequest,
  UpdateCreatorIdentityRequest,
} from './identities.js';
export {
  speechProfileFieldsSchema,
  speechProfileFieldsOverrideSchema,
  DEFAULT_SPEECH_PROFILE,
  mergeSpeechProfileFields,
  speechProfileVersionSchema,
  speechProfileSchema,
  createSpeechProfileRequestSchema,
  updateSpeechProfileRequestSchema,
} from './speech.js';
export type { SpeechProfileFields, SpeechProfileFieldsOverride, SpeechProfile, SpeechProfileVersion } from './speech.js';

// Workspace / 成员契约（P01-03）
export {
  WORKSPACE_ROLES,
  workspaceRoleSchema,
  workspaceSchema,
  workspaceWithRoleSchema,
  workspaceMemberSchema,
  createWorkspaceRequestSchema,
  updateWorkspaceRequestSchema,
  addWorkspaceMemberRequestSchema,
  updateWorkspaceMemberRoleRequestSchema,
} from './workspaces.js';
export type { WorkspaceRole, Workspace, WorkspaceWithRole, WorkspaceMember } from './workspaces.js';

export { healthResponseSchema } from './health.js';
export type { HealthResponse } from './health.js';
