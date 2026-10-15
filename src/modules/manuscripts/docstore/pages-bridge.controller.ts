/**
 * modules/manuscripts/docstore/pages-bridge.controller.ts
 * Backward-compatibility re-export of domain-focused Pages controllers.
 *
 * The monolithic bridge has been decomposed into clean domain-focused controllers
 * under `./controllers/`:
 *  - `PagesDocController` (aliased as `PagesBridgeController`): Document CRUD, Files, Trash/Restore, Duplicate, Project Pages, Labels
 *  - `PagesReviewController`: Inline Comments, Comment Threads, and Track-Change Suggestions
 *  - `PagesHistoryExportController`: Version History, Diff, Timeline, Point-in-Time At, Export, and Incremental Sync
 *  - `PagesSearchPresenceController`: Full-Text/Regex Search & Replace, and Real-Time Presence / SSE Stream
 */

export {
  PagesDocController,
  PagesDocController as PagesBridgeController,
} from './controllers/pages-doc.controller';
export type { PageDocRanges } from './controllers/pages-doc.controller';
export { PagesReviewController } from './controllers/pages-review.controller';
export type { CreateSuggestionBody } from './controllers/pages-review.controller';
export { PagesHistoryExportController } from './controllers/pages-history-export.controller';
export { PagesSearchPresenceController } from './controllers/pages-search-presence.controller';
