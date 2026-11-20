/**
 * modules/realtime/index.ts
 * Canonical public barrel for the Service-Ready Realtime Boundary.
 */

export { RealtimeModule } from './realtime.module';
export { RealtimeClientModule } from './client/module';
export { RealtimeServerModule } from './server/module';
export { RealtimeFacade, type RealtimeStats } from './realtime.facade';
export {
  RealtimeControlClient,
  type RealtimeControlClientOptions,
} from './internal/client';
export { RemoteLiveCollaborationAdapter } from './internal/remote-collab';
export {
  RealtimeInternalAuthGuard,
  resolveRealtimeInternalKey,
  REALTIME_INTERNAL_KEY_HEADER,
} from './internal/auth';

// Shared WebSocket Platform
export { RealtimeCoreModule } from './core/module';
export {
  RealtimeConfigService,
  REALTIME_NAMESPACES,
  REALTIME_CORE_DEFAULTS,
  createWsCorsOptions,
  parsePositiveInt,
  type RealtimeNamespace,
  type WsCorsOptions,
  type RateLimitBudget,
  type RealtimeTransportConfig,
  type WsRateLimiterConfig,
} from './core/config';
export {
  WsAuthService,
  createWsConnectionMiddleware,
  type WsUserSession,
  type SocketIOMiddleware,
} from './core/auth';
export {
  WsAllExceptionsFilter,
  type RealtimeErrorCode,
  type WsErrorPayload,
  RealtimeException,
  RealtimeAuthRequiredException,
  RealtimeOriginNotAllowedException,
  RealtimeAccessDeniedException,
  RealtimeRoleInsufficientException,
  RealtimeValidationFailedException,
  RealtimeRateLimitedException,
  RealtimeServiceUnavailableException,
} from './core/errors';
export {
  WsRateLimiter,
  type WsRateLimitPolicy,
  type EventBucketClassifier,
} from './core/rate-limit';
export {
  WS_ROOM_PREFIXES,
  formatProjectRoom,
  formatDocRoom,
  formatUserRoom,
  formatConversationRoom,
  isSocketInRoom,
  emitToLocalRoom,
  evictUserFromRoom,
} from './core/rooms';
export {
  RealtimeEventBus,
  REALTIME_BUS_CHANNEL,
  REALTIME_BUS_MODE,
  type RealtimeBusMode,
  type RealtimeBusEnvelope,
  type RealtimeBusHandler,
  type ChatReactionBroadcastPayload,
} from './core/bus';

// Domain-Boundary Ports (for future HTTP/RPC standalone service extraction)
export {
  CHAT_REALTIME_PORT,
  type ChatRealtimePort,
  type ChatSendMessageInput,
} from './ports/chat';
export {
  WORK_ITEMS_ACCESS_PORT,
  type WorkItemsAccessPort,
} from './ports/work-items';

// Channel 1: /pages (Editor Collaboration & Yjs CRDT)
export { RealtimePagesModule } from './channels/pages/module';
export {
  PagesRealtimeConfigService,
  PAGES_REALTIME_DEFAULTS,
  PAGES_DOMAIN_EVENTS,
  PAGES_EVENTS,
  PAGES_ROOMS,
  PAGES_REDIS_KEYS,
  PAGES_REDIS_CHANNELS,
  PAGES_PRESENCE_COLORS,
  classifyPagesEvent,
  isPersonalSpaceAlias,
  type PagesRateBucket,
  type PagesYjsConfig,
  type PagesAccessConfig,
  type PagesPresenceConfig,
  type PagesSessionConfig,
  type PagesRateLimitBudgets,
} from './channels/pages/config';
export {
  WsAccess,
  WsAccessGuard,
  type WsAccessLevel,
} from './channels/pages/guard';
export { YjsUpdateValidator } from './channels/pages/yjs/sync';

// Channel 2: /chat (Messaging)
export { RealtimeChatChannelModule } from './channels/chat/module';
export {
  ChatGateway,
  type BroadcastReactionPayload,
} from './channels/chat/gateway';
export {
  ChatRealtimeConfigService,
  CHAT_EVENTS,
  CHAT_ROOMS,
  CHAT_RATE_CLASS_MAP,
  CHAT_REALTIME_DEFAULTS,
  classifyChatEvent,
  type ChatRateBucket,
  type ChatRateLimitBudgets,
} from './channels/chat/config';

// Channel 3: /work-items (Project Kanban & Tasks)
export { RealtimeWorkItemsChannelModule } from './channels/work-items/module';
export { WorkItemsGateway } from './channels/work-items/gateway';
export { WorkItemsWsGuard } from './channels/work-items/guard';
export {
  WorkItemsRealtimeConfigService,
  WORK_ITEMS_EVENTS,
  WORK_ITEMS_ROOMS,
  WORK_ITEMS_RATE_CLASS_MAP,
  WORK_ITEMS_REALTIME_DEFAULTS,
  classifyWorkItemsEvent,
  type WorkItemsRateBucket,
  type WorkItemsRateLimitBudgets,
} from './channels/work-items/config';
