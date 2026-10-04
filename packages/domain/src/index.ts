export {
  createChannel,
  getChannel,
  getChannelStyleVersion,
  listChannelStyleVersions,
  listChannels,
  updateChannel,
} from './channels.js';
export type { DomainDeps } from './channels.js';
export {
  createCreatorIdentity,
  getCreatorIdentity,
  listCreatorIdentities,
  updateCreatorIdentity,
} from './creator-identities.js';
export {
  createSpeechProfile,
  getSpeechProfile,
  listSpeechProfileVersions,
  listSpeechProfiles,
  updateSpeechProfile,
} from './speech-profiles.js';
export {
  addScene,
  assembleSceneGraph,
  createProject,
  getProject,
  getProjectDetail,
  listProjects,
} from './projects.js';
export { processEdits, replaySceneContent } from './edits.js';
export type { ProcessEditsInput, ProcessEditsResult, SceneContentSnapshot } from './edits.js';
export {
  AUTO_SNAPSHOT_INTERVAL,
  buildSnapshotPayload,
  createProjectVersion,
  getProjectVersion,
  listProjectVersions,
  loadSceneRows,
} from './versions.js';
export { redoProject, undoProject } from './undo-redo.js';
