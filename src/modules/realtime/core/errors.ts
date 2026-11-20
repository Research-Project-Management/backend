import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  HttpException,
  Logger,
} from '@nestjs/common';
import { BaseWsExceptionFilter, WsException } from '@nestjs/websockets';
import { Socket } from 'socket.io';

export type RealtimeErrorCode =
  | 'AUTH_REQUIRED'
  | 'ORIGIN_NOT_ALLOWED'
  | 'ACCESS_DENIED'
  | 'ROLE_INSUFFICIENT'
  | 'VALIDATION_FAILED'
  | 'RATE_LIMITED'
  | 'SERVICE_UNAVAILABLE';

export interface WsErrorPayload {
  success: false;
  error: string;
  code: RealtimeErrorCode;
  retryable: boolean;
}

export class RealtimeException extends WsException {
  public readonly code: RealtimeErrorCode;
  public readonly retryable: boolean;

  constructor(message: string, code: RealtimeErrorCode, retryable = false) {
    const payload: WsErrorPayload = {
      success: false,
      error: message,
      code,
      retryable,
    };
    super(payload);
    this.name = code;
    this.code = code;
    this.retryable = retryable;
  }

  public toPayload(): WsErrorPayload {
    return {
      success: false,
      error: this.message,
      code: this.code,
      retryable: this.retryable,
    };
  }
}

export class RealtimeAuthRequiredException extends RealtimeException {
  constructor(message = 'Authentication required') {
    super(message, 'AUTH_REQUIRED', false);
  }
}

export class RealtimeOriginNotAllowedException extends RealtimeException {
  constructor(message = 'Origin not allowed') {
    super(message, 'ORIGIN_NOT_ALLOWED', false);
  }
}

export class RealtimeAccessDeniedException extends RealtimeException {
  constructor(message = 'Access denied') {
    super(message, 'ACCESS_DENIED', false);
  }
}

export class RealtimeRoleInsufficientException extends RealtimeException {
  constructor(message = 'Insufficient role for this action') {
    super(message, 'ROLE_INSUFFICIENT', false);
  }
}

export class RealtimeValidationFailedException extends RealtimeException {
  constructor(message = 'Invalid message') {
    super(message, 'VALIDATION_FAILED', false);
  }
}

export class RealtimeRateLimitedException extends RealtimeException {
  constructor(message = 'Too many events') {
    super(message, 'RATE_LIMITED', true);
  }
}

export class RealtimeServiceUnavailableException extends RealtimeException {
  constructor(message = 'Service temporarily unavailable') {
    super(message, 'SERVICE_UNAVAILABLE', true);
  }
}

@Catch()
export class WsAllExceptionsFilter extends BaseWsExceptionFilter {
  private readonly logger = new Logger(WsAllExceptionsFilter.name);

  override catch(exception: unknown, host: ArgumentsHost) {
    const client = host.switchToWs().getClient<Socket>();

    let payload: WsErrorPayload;

    if (exception instanceof RealtimeException) {
      payload = exception.toPayload();
      this.logger.warn(
        `RealtimeException [${payload.code}] on socket ${client?.id}: ${payload.error}`,
      );
    } else if (exception instanceof BadRequestException) {
      // NestJS ValidationPipe throws BadRequestException.
      // Must not leak internal validation details or echo input payloads (RT-06 / SC-006).
      payload = {
        success: false,
        error: 'Invalid message',
        code: 'VALIDATION_FAILED',
        retryable: false,
      };
      this.logger.warn(
        `Validation failed on socket ${client?.id}: ${JSON.stringify(exception.getResponse())}`,
      );
    } else if (exception instanceof WsException) {
      const err = exception.getError();
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        'success' in err
      ) {
        payload = err as WsErrorPayload;
      } else {
        payload = {
          success: false,
          error: typeof err === 'string' ? err : 'Invalid message',
          code: 'VALIDATION_FAILED',
          retryable: false,
        };
      }
      this.logger.warn(`WsException on socket ${client?.id}: ${payload.error}`);
    } else if (exception instanceof HttpException) {
      const status = exception.getStatus();
      payload = {
        success: false,
        error: status >= 500 ? 'Internal server error' : exception.message,
        code:
          status === 403
            ? 'ACCESS_DENIED'
            : status === 401
              ? 'AUTH_REQUIRED'
              : 'SERVICE_UNAVAILABLE',
        retryable: status >= 500,
      };
      this.logger.warn(
        `HttpException [${status}] on socket ${client?.id}: ${exception.message}`,
      );
    } else {
      const err = exception as Error;
      this.logger.error(
        `Unhandled WebSocket exception on socket ${client?.id}: ${err?.message || String(exception)}`,
        err?.stack,
      );
      payload = {
        success: false,
        error: 'Internal server error',
        code: 'SERVICE_UNAVAILABLE',
        retryable: true,
      };
    }

    if (client && typeof client.emit === 'function') {
      client.emit('error', payload);
    }
  }
}
