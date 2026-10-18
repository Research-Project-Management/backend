import { WsException } from '@nestjs/websockets';

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
