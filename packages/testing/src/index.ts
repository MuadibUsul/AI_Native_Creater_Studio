export {
  contentDocumentSchema,
  contentBlockSchema,
  claimSchema,
  citationSchema,
  sourceSnapshotSchema,
  datasetSchema,
  fixtureExpectedSchema,
  sourcesFileSchema,
  datasetsFileSchema,
  negativeCaseSchema,
} from './fixture-schema.js';
export type {
  ContentDocument,
  ContentBlock,
  Claim,
  SourceSnapshot,
  StructuredDataset,
  FixtureExpected,
  FixtureBundle,
  NegativeCase,
} from './fixture-schema.js';
export { auditFixture, sha256Hex, OVERFLOW_NARRATION_MAX_CHARS, OVERFLOW_TITLE_MAX_CHARS } from './audit.js';
export type { AuditIssue, AuditIssueCode } from './audit.js';
export {
  FIXTURES_ROOT,
  GOLDEN_FRENCH_DEBT_DIR,
  NEGATIVE_CASES_DIR,
  loadFixtureBundle,
  loadNegativeCases,
  readJson,
} from './load.js';
