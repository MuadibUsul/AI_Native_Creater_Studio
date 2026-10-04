export {
  checkRules,
  isWorkspaceDep,
  WEB_APP_DIRS,
  WEB_APP_ALLOWED_WORKSPACE_DEPS,
  PROVIDER_ALLOWED_WORKSPACE_DEPS,
} from './rules.js';
export type { WorkspacePackage, Violation } from './rules.js';
export { scanWorkspace } from './scan.js';
