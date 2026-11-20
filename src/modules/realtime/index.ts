/**
 * modules/realtime/index.ts
 * Canonical public barrel for the Realtime Modular Monolith boundary.
 */

export { RealtimeModule } from './realtime.module';
export { RealtimeFacade } from './realtime.facade';

// Shared WebSocket Kernel (consumed by independent domain gateways such as ChatGateway)
export { RealtimeCoreModule } from './core/core.module';
export { RealtimeConfigService } from './core/realtime.config';
export {
  RealtimeHealthService,
  type RealtimeStats,
} from './core/realtime-health.service';
export {
  REALTIME_NAMESPACES,
  createWsCorsOptions,
  type RealtimeNamespace,
  type WsCorsOptions,
} from './core/realtime.namespaces';
export { WsAuthService, type WsUserSession } from './core/ws-auth.service';
export {
  createWsConnectionMiddleware,
  type SocketIOMiddleware,
} from './core/ws-connection.middleware';
export { WsAllExceptionsFilter } from './core/ws-exception.filter';
export {
  WsRateLimiter,
  type RealtimeEventClass,
  type EventClassClassifier,
} from './core/ws-rate-limiter';
export {
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
} from './core/ws-errors';

// Pages Realtime Subsystem Public Seams
export { RealtimePagesModule } from './pages/pages.module';
export {
  PAGES_EVENTS,
  PAGES_ROOMS,
  PAGES_REDIS_KEYS,
} from './pages/pages.constants';
export {
  WsAccess,
  type WsAccessLevel,
} from './pages/access/ws-access.decorator';
export { WsAccessGuard } from './pages/access/ws-access.guard';
export { YjsUpdateValidator } from './pages/yjs/yjs-update.validator';
