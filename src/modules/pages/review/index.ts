/**
 * modules/pages/review/index.ts
 * Public entry point for the Pages Review, Comments & Track Changes module.
 */

export { REVIEW_EVENTS } from './review.events';
export {
  BatchResolveDto,
  CreateCommentDto,
  CreateSuggestionDto,
  ReplyDto,
  ResolveCommentDto,
  UpdateCommentDto,
} from './dto/review.dto';
export { UpdateReviewStatusDto } from './dto/status.dto';
export {
  REVIEW_STATUSES,
  type ReviewStatus,
  assertReviewTransitionAllowed,
  validateCommentLines,
  validateSuggestionRange,
} from './domain/review.policy';
export {
  ChangeNotFoundError,
  InvalidChangeError,
  InvalidReplyError,
  InvalidThreadError,
  PatchConflictError,
  ResolvedThreadError,
  StaleAnchorError,
  ThreadNotFoundError,
} from './domain/review.errors';
export { CommentsService } from './services/comments.service';
export { SuggestionsService } from './services/suggestions.service';
export { ReviewStatusService } from './services/status.service';
export { ReviewModule } from './review.module';
