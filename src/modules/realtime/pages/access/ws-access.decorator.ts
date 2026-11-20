import { SetMetadata, CustomDecorator } from '@nestjs/common';

export type WsAccessLevel = 'member' | 'read' | 'write' | 'none';

export const WS_ACCESS_LEVEL_KEY = 'ws:access_level';

export const WsAccess = (level: WsAccessLevel): CustomDecorator<string> =>
  SetMetadata(WS_ACCESS_LEVEL_KEY, level);
