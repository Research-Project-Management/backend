/**
 * modules/realtime/index.ts
 * Public Modular Monolith Barrel for the Realtime Module.
 * External modules should import from '@/modules/realtime' (or '@/modules/realtime/realtime.facade').
 */

export { RealtimeModule } from './realtime.module';
export { RealtimeFacade } from './realtime.facade';
export { RealtimeCoreModule, CoreModule } from './core/core.module';
export {
  RealtimeManuscriptsModule,
  ManuscriptsModule,
} from './manuscripts/manuscripts.module';
export {
  RealtimeNotificationsModule,
  NotificationsModule,
} from './notifications/notifications.module';
export { YjsUpdateValidator } from './manuscripts/yjs-update-validator';
export { WsAuthService, type WsUserSession } from './core/ws-auth.guard';
export { createWsConnectionMiddleware } from './core/ws-connection.middleware';
export { WsAllExceptionsFilter } from './core/ws-exception.filter';
export { WsRateLimiter } from './core/ws-rate-limiter';
export { WsAccess, type WsAccessLevel } from './core/ws-access.decorator';
export { WsAccessGuard } from './core/ws-access.guard';
export {
  REALTIME_NAMESPACES,
  REALTIME_EVENTS,
  REDIS_KEYS,
} from './core/realtime.constant';
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
