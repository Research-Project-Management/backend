import { Catch, ArgumentsHost, Logger } from '@nestjs/common';
import { BaseWsExceptionFilter, WsException } from '@nestjs/websockets';
import { Socket } from 'socket.io';

@Catch()
export class WsAllExceptionsFilter extends BaseWsExceptionFilter {
  private readonly logger = new Logger(WsAllExceptionsFilter.name);

  override catch(exception: unknown, host: ArgumentsHost) {
    const client = host.switchToWs().getClient<Socket>();
    const message =
      exception instanceof WsException
        ? exception.getError()
        : exception instanceof Error
          ? exception.message
          : 'Internal WebSocket error';

    this.logger.warn(`WS Exception on socket ${client?.id}: ${JSON.stringify(message)}`);

    if (client && typeof client.emit === 'function') {
      client.emit('error', {
        status: 'error',
        message,
        timestamp: new Date().toISOString(),
      });
    }
  }
}
