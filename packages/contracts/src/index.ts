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
export type { ContentDocument, ContentBlock, Claim, ContentExtractions, ArticleFetcher } from './content.js';
export {
  CONTENT_SOURCE_TYPES,
  contentSourceTypeSchema,
  CONTENT_INPUT_ERROR_REASONS,
  createContentRequestSchema,
  contentNormalizationSchema,
  contentDocumentRecordSchema,
  contentSourceSchema,
  updateSourceRequestSchema,
} from './content.js';
export type {
  ContentSourceType,
  ContentInputErrorReason,
  CreateContentRequest,
  ContentNormalization,
  ContentDocumentRecord,
  ContentSource,
  UpdateSourceRequest,
} from './content.js';

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

// 叙事契约（P04-03 / §8、§52）
export {
  NARRATION_BLOCK_STATUSES,
  narrationBlockStatusSchema,
  narrativeChapterSchema,
  narrationBlockSchema,
  requiredVisualFactSchema,
  narrativePlanSchema,
  narrativeGenerationRequestSchema,
  llmCompletionSchema,
  NARRATIVE_ERROR_REASONS,
  narrativeGenerationResultSchema,
  updateNarrationBlockRequestSchema,
  VERBATIM_OVERLAP_THRESHOLD,
  VERBATIM_NGRAM,
  MAX_REPAIRS,
  MAX_LLM_ATTEMPTS,
} from './narrative.js';
export type {
  NarrativeChapter,
  NarrationBlock,
  RequiredVisualFact,
  NarrativePlan,
  NarrativeGenerationRequest,
  LlmCompletion,
  LlmAdapter,
  NarrativeErrorReason,
  NarrativeGenerationResult,
  UpdateNarrationBlockRequest,
} from './narrative.js';

// 证据与数据契约（P04-02 / §10.3、§85）
export {
  EVIDENCE_ERROR_REASONS,
  claimRecordSchema,
  citationRecordSchema,
  numericMentionSchema,
  extractionResultSchema,
  createDatasetRequestSchema,
  datasetRecordSchema,
  FACT_VISUAL_STRATEGIES,
  factVisualStrategySchema,
  factVisualDecisionSchema,
  chartBindingCheckSchema,
} from './evidence.js';
export type {
  EvidenceErrorReason,
  ClaimRecord,
  CitationRecord,
  NumericMention,
  ExtractionResult,
  CreateDatasetRequest,
  DatasetRecord,
  FactVisualStrategy,
  FactVisualDecision,
  ChartBindingCheck,
} from './evidence.js';

// 视觉语法契约（P04-04 / §10.1、§10.2）
export {
  SEMANTIC_TYPES,
  semanticTypeSchema,
  RECOGNITION_METHODS,
  recognitionMethodSchema,
  visualGrammarRuleSchema,
  VISUAL_GRAMMAR_VERSION,
  recognitionEvidenceSchema,
  visualPlanItemSchema,
  visualPlanSchema,
  VISUAL_GRAMMAR_ERROR_REASONS,
} from './visual-grammar.js';
export type {
  SemanticType,
  RecognitionMethod,
  VisualGrammarRule,
  RecognitionEvidence,
  VisualPlanItem,
  VisualPlan,
  VisualGrammarErrorReason,
} from './visual-grammar.js';

// Render 契约（P07-03 / §28、§39）
export {
  RENDER_PROFILES,
  renderProfileSchema,
  RENDER_PROFILE_SPECS,
  RENDER_STATUSES,
  renderStatusSchema,
  RENDER_ERROR_REASONS,
  renderInputSchema,
  renderRecordSchema,
  createRenderRequestSchema,
} from './render.js';
export type {
  RenderProfile,
  RenderStatus,
  RenderErrorReason,
  RenderInput,
  RenderRecord,
  CreateRenderRequest,
} from './render.js';

// Final 合成执行契约（P07-04 / §28、§39、§58）
export {
  RENDER_EXECUTION_SPEC_VERSION,
  RENDER_EXECUTION_RESULT_VERSION,
  RENDER_MANIFEST_VERSION,
  RENDER_EXECUTION_ERROR_REASONS,
  compositionSceneInputSchema,
  stagedAssetSchema,
  renderExecutionMusicTrackSchema,
  renderExecutionCaptionsSchema,
  renderManifestBaseSchema,
  RENDER_EXECUTION_FILE_KINDS,
  renderExecutionFileKindSchema,
  renderExecutionFileSchema,
  renderManifestSchema,
  renderExecutionSpecSchema,
  renderExecutionResultSchema,
  RENDER_EXECUTION_FILE_NAMES,
  RENDER_EXECUTION_FILE_MIME_TYPES,
} from './render-execution.js';
// 部署环境配置契约（P08-01 / §50）
export {
  validateEnv,
  formatEnvFailure,
  baseEnvShape,
  apiEnvSchema,
  workerEnvSchema,
  crossCheckWorkerEnv,
} from './env.js';
export type { EnvIssue, EnvValidationResult, ApiEnv, WorkerEnv } from './env.js';

// 审批与受控导出契约（P07-06 / §87、§54）
export {
  APPROVAL_DECISIONS,
  approvalDecisionSchema,
  renderApprovalSchema,
  decideApprovalRequestSchema,
  APPROVAL_ERROR_REASONS,
  exportPackageEntrySchema,
  exportPackageSchema,
} from './approval.js';
export type { ApprovalDecision, RenderApproval, DecideApprovalRequest, ApprovalErrorReason, ExportPackageEntry, ExportPackage } from './approval.js';

// 发布前 QA 契约（P07-05 / §86、§87）
export {
  QA_CATEGORIES,
  qaCategorySchema,
  QA_SEVERITIES,
  qaSeveritySchema,
  QA_STATUSES,
  qaStatusSchema,
  QA_CHECK_IDS,
  qaCheckIdSchema,
  qaCheckSchema,
  QA_REPORT_VERSION,
  qaReportSchema,
  QA_ERROR_REASONS,
  mediaProbeResultSchema,
  QA_DURATION_TOLERANCE_MS,
} from './qa.js';
export type { QaCategory, QaSeverity, QaStatus, QaCheckId, QaCheck, QaReport, QaErrorReason, MediaProbeResult, RenderMediaProbe } from './qa.js';

// Custom Motion 生成与验证契约（P07-02 / §11.2）
export {
  MOTION_PROMPT_VERSION,
  MOTION_VALIDATION_REPORT_VERSION,
  MOTION_DEPENDENCY_WHITELIST,
  CUSTOM_MOTION_ERROR_REASONS,
  motionComponentDraftSchema,
  motionValidationFixtureSchema,
  MOTION_VALIDATION_STAGES,
  motionValidationStageSchema,
  motionFrameSampleSchema,
  motionValidationReportSchema,
  motionGenerationInputSchema,
  customMotionComponentVersionSchema,
  customMotionComponentSchema,
  startCustomMotionRequestSchema,
  customMotionJobInputSchema,
  motionSampleFrames,
  CUSTOM_MOTION_SCENE_TYPE,
} from './custom-motion.js';
export type {
  CustomMotionErrorReason,
  MotionComponentDraft,
  MotionValidationFixture,
  MotionValidationStage,
  MotionFrameSample,
  MotionValidationReport,
  MotionValidator,
  MotionGenerationInput,
  CustomMotionComponentVersion,
  CustomMotionComponent,
  StartCustomMotionRequest,
  CustomMotionJobInput,
} from './custom-motion.js';

export type {
  RenderExecutionErrorReason,
  CompositionSceneInputDto,
  StagedAsset,
  RenderExecutionMusicTrack,
  RenderExecutionCaptions,
  RenderManifestBase,
  RenderExecutionFileKind,
  RenderExecutionFile,
  RenderManifest,
  RenderExecutionSpec,
  RenderExecutionResult,
  RenderExecutor,
} from './render-execution.js';

// Native Fallback 回绑契约（P06-07 / §39、§40、§45）
export { REBIND_ERROR_REASONS, rebindExternalResultRequestSchema } from './billing.js';
export type { RebindErrorReason, RebindExternalResultRequest } from './billing.js';

// 混音与字幕契约（P06-06 / §58、§59）
export {
  MIX_ERROR_REASONS,
  mixInputTrackSchema,
  gainKeyframeSchema,
  mixTrackPlanSchema,
  mixPlanSchema,
  DEFAULT_DUCKING,
  SUBTITLE_FORMATS,
  subtitleFormatSchema,
  CAPTION_POSITIONS,
  captionStyleSchema,
  captionRenderOptionsSchema,
  subtitleOutputSchema,
  mixPlanRequestSchema,
} from './mixdown.js';
export type {
  MixErrorReason,
  MixInputTrack,
  GainKeyframe,
  MixTrackPlan,
  MixPlan,
  SubtitleFormat,
  CaptionStyle,
  CaptionRenderOptions,
  SubtitleOutput,
  MixPlanRequest,
} from './mixdown.js';
export { buildSubtitles, planAudioMix, toSrtTime, toVttTime, visualWidthOf, wrapCaption } from './mix-compute.js';
export type { CaptionCue, MixPlanInput } from './mix-compute.js';

// Master Narration 与 Alignment 契约（P06-03 / §5.1、§58）
export {
  ALIGNMENT_METHODS,
  alignmentMethodSchema,
  ALIGNMENT_ERROR_REASONS,
  alignmentWordSchema,
  alignmentSegmentSchema,
  narrationCueSchema,
  masterNarrationSchema,
  synthesisVoiceRefSchema,
} from './alignment.js';
export type {
  AlignmentMethod,
  AlignmentErrorReason,
  AlignmentWord,
  AlignmentSegment,
  NarrationCue,
  MasterNarration,
  SynthesisVoiceRef,
  SynthesizedAudio,
  AudioSynthesisAdapter,
  AlignmentProvider,
} from './alignment.js';

// AI Edit 契约（P05-06 / §37、§52）
export {
  EDIT_PLAN_VERSION,
  AI_EDIT_ERROR_REASONS,
  editPlanOperationSchema,
  editPlanImpactSchema,
  editPlanSchema,
  createEditPlanRequestSchema,
} from './ai-edit.js';
export type { AiEditErrorReason, EditPlanOperation, EditPlanImpact, EditPlan, CreateEditPlanRequest } from './ai-edit.js';

// 组件协议契约（P05-01 / §11.1、§57）
export {
  COMPONENT_PROTOCOL_VERSION,
  componentVersionSchema,
  sceneComponentTypeSchema,
  aspectRatioSchema,
  componentFixtureSchema,
  componentCatalogEntrySchema,
  COMPONENT_VALIDATION_REASONS,
  sceneRenderContextSchema,
  ASPECT_RATIO_SIZES,
} from './scene-components.js';
export type {
  AspectRatio,
  ComponentFixture,
  ComponentCatalogEntry,
  ComponentValidationReason,
  SceneRenderContext,
} from './scene-components.js';

// SpeechPlan 契约（P04-06 / §94、§6.4）
export {
  SPEECH_PLAN_VERSION,
  SPEECH_SCENE_ROLES,
  speechSceneRoleSchema,
  SPEECH_WARNING_CODES,
  speechWarningSchema,
  speechPauseSchema,
  speechEmphasisSpanSchema,
  speechSegmentSchema,
  speechPlanSchema,
  speechStyleRuleSchema,
  SPEECH_ROLE_STYLE_DEFAULTS,
  speechStyleOverridesSchema,
} from './speech-plan.js';
export type {
  SpeechSceneRole,
  SpeechWarningCode,
  SpeechWarning,
  SpeechPause,
  SpeechEmphasisSpan,
  SpeechSegment,
  SpeechPlan,
  SpeechStyleRule,
  SpeechStyleOverrides,
} from './speech-plan.js';

// Director 契约（P04-05 / §9）
export {
  DIRECTOR_PLAN_VERSION,
  directorPolicySchema,
  directorWarningSchema,
  DIRECTOR_WARNING_CODES,
  directorAssetRequirementSchema,
  directorSceneSchema,
  directorAssetPlanItemSchema,
  directorProviderJobPlanSchema,
  directorPlanSchema,
  directorApplyRequestSchema,
  DIRECTOR_APPLY_ERROR_REASONS,
} from './director.js';
export type {
  DirectorPolicy,
  DirectorPolicyInput,
  DirectorWarning,
  DirectorWarningCode,
  DirectorAssetRequirement,
  DirectorScene,
  DirectorAssetPlanItem,
  DirectorProviderJobPlan,
  DirectorPlan,
  DirectorApplyRequest,
  DirectorApplyErrorReason,
} from './director.js';

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
  GENERATE_JOB_TYPE,
  RENDER_FINAL_JOB_TYPE,
  MOTION_GENERATE_JOB_TYPE,
  RENDER_QA_JOB_TYPE,
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
