import { SetMetadata, CustomDecorator } from '@nestjs/common';

export type WsAccessLevel = 'member' | 'read' | 'write' | 'none';

export const WS_ACCESS_LEVEL_KEY = 'ws:access_level';

/**
 * Declares the minimum authorization level required to invoke a WebSocket event handler.
 * Evaluated by WsAccessGuard against the socket's joined project/document context.
 *
 * - 'none': No project context required (e.g., leave events if unjoined)
 * - 'member': Any member of the project (Reviewer or higher)
 * - 'read': Reviewer or higher
 * - 'write': Contributor or higher (effective write permission)
 */
export const WsAccess = (level: WsAccessLevel): CustomDecorator<string> =>
  SetMetadata(WS_ACCESS_LEVEL_KEY, level);
