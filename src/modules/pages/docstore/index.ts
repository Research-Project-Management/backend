/**
 * modules/pages/docstore/index.ts
 * Public interface for the Pages Docstore subsystem.
 */

export {
  IDocPersistor,
  DocstoreMetrics,
  type DocstoreMetricsSummary,
  type CreateDocData,
  type UpdateDocData,
  type PatchDocData,
} from './domain/doc.ports';
export { TextDoc, NoopDiffChecker, type TextDocProps } from './domain/text-doc.entity';
export { LineArray } from './domain/line-array';
export {
  DocRangeVo,
  type DocRanges,
  type ReviewRoundInfo,
  type TrackChangeItem,
  type CommentItem,
} from './domain/doc-range';
export {
  DocNotFoundError,
  DocModifiedError,
  DocTooLargeError,
  NullByteDetectedError,
  Md5MismatchError,
  InvalidSearchPatternError,
  ArchiveObjectNotFoundError,
  ArchiveWriteFailedError,
} from './domain/doc.errors';
export {
  CreateDocDto,
  UpdateDocDto,
  PatchDocDto,
  DocResponseDto,
} from './dto/doc.dto';
export {
  hydratePageDocLines,
  findPageRecordWithNode,
  formatPageByIdResponse,
  assertExpectedVersionAndRev,
  executeDocstoreUpdateWithOcc,
} from './domain/doc-occ.helper';
export { DocstoreRepository } from './repositories/docstore.repository';
export {
  DocArchiveRepository,
  InMemoryDocArchiveRepository,
} from './repositories/archive.repository';
export { ScopeRepository } from './repositories/scope.repository';
export { PresenceService, type ActivePresenceUser, type HeartbeatBody } from './services/presence.service';
export {
  SearchReplaceService,
  type SearchDocumentsParams,
  type ReplaceDocumentsParams,
} from './services/search-replace.service';
export {
  DocstoreService,
  type PeekDocResult,
  type UpdateDocResult,
} from './docstore.service';
export { DocstoreModule } from './docstore.module';
