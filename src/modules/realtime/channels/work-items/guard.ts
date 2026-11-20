import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { Socket } from 'socket.io';
import type { WsUserSession } from '../../core/auth';
import {
  RealtimeAccessDeniedException,
  RealtimeAuthRequiredException,
  RealtimeValidationFailedException,
} from '../../core/errors';
import {
  WORK_ITEMS_ACCESS_PORT,
  type WorkItemsAccessPort,
} from '../../ports/work-items';

@Injectable()
export class WorkItemsWsGuard implements CanActivate {
  constructor(
    @Inject(WORK_ITEMS_ACCESS_PORT)
    private readonly accessPort: WorkItemsAccessPort,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const ws = context.switchToWs();
    const client = ws.getClient<Socket>();
    const payload = ws.getData<{ projectId?: unknown }>();

    const session = client?.data as Partial<WsUserSession> | undefined;
    if (
      !session?.authenticated ||
      typeof session.userId !== 'string' ||
      session.userId.length === 0
    ) {
      throw new RealtimeAuthRequiredException();
    }

    if (
      typeof payload?.projectId !== 'string' ||
      payload.projectId.trim().length === 0
    ) {
      throw new RealtimeValidationFailedException('Invalid projectId');
    }

    const role = await this.accessPort.getRole(
      payload.projectId.trim(),
      session.userId,
    );
    if (!role) {
      throw new RealtimeAccessDeniedException(
        'Access denied to project work items',
      );
    }

    return true;
  }
}
