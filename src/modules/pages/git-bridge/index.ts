/**
 * modules/pages/git-bridge/index.ts
 * Public entry point for the Flux Git Smart-HTTP Bridge module.
 */

export { CreateTokenDto, RepoQueryDto } from './dto/token.dto';
export {
  GitBridgeError,
  LfsUnsupportedError,
  PushRejectedError,
  QuotaExceededError,
  TokenLimitError,
} from './domain/errors';
export {
  DEFAULT_BRANCH,
  GC_THRESHOLD,
  GIT_SERVICES,
  GIT_USER,
  IDLE_TTL_MS,
  MAIN_REF,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_PUSH_BYTES,
  MAX_TOKENS,
  RepoPathVo,
  SWEEP_MS,
  TOKEN_TTL_MS,
  TOUCH_TTL_MS,
  canRead,
  canWrite,
  parseRepoId,
  type GitService,
  type ProjectRole,
} from './domain/policy';
export {
  EMPTY_TREE_OID,
  FLUSH_PKT,
  PktReportBuilder,
  hasSideband,
  isLfsPointer,
  pktLine,
  runBlobGuards,
  runTreeGuards,
  splitLines,
  type BlobCtx,
  type TreeEntryCtx,
} from './domain/pack.domain';
export {
  AccessTokenVo,
  PAT_PREFIX,
  formatTokenPrefix,
  parseAuthHeader,
  sha256Hex,
  type TokenView,
} from './domain/token.domain';
export {
  GitBridgeRepository,
  type PushTransitionInput,
  type RepoTarget,
  type TokenRecord,
} from './git-bridge.repository';
export {
  RepoAdapter,
  type BlobEntry,
  type DiffEntry,
  type GitAuthor,
  type PushDiff,
} from './adapters/repo.adapter';
export { PackAdapter, type RpcResult } from './adapters/pack.adapter';
export { TokenService } from './services/token.service';
export {
  SyncService,
  EntryMemento,
  type PushSummary,
} from './services/sync.service';
export { MaintenanceService } from './services/maintenance.service';
export { GitBridgeModule } from './git-bridge.module';
