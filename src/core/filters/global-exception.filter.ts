import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { FastifyRequest, FastifyReply } from 'fastify';
import { ApiErrorEnvelope } from '../types/api-response.interface';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();

    // If headers or reply were already sent (e.g. streaming SSE or file buffers aborted by client), skip duplicate reply
    if (response.sent || response.raw?.headersSent) {
      this.logger.warn(
        `[GlobalExceptionFilter] Reply already sent or connection closed. Suppressed: ${
          exception instanceof Error ? exception.message : String(exception)
        }`,
      );
      return;
    }

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let errorCode = 'INTERNAL_SERVER_ERROR';
    let message = 'An unexpected internal server error occurred';
    let details: unknown = undefined;

    const isProduction = process.env.NODE_ENV === 'production';

    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const res = exception.getResponse();

      errorCode = this.mapStatusToErrorCode(statusCode);

      if (typeof res === 'string') {
        message = res;
      } else if (typeof res === 'object' && res !== null) {
        const resObj = res as Record<string, unknown>;
        if (Array.isArray(resObj.message)) {
          errorCode = 'VALIDATION_ERROR';
          message = resObj.message[0] || 'Validation failed';
          details = resObj.message;
        } else {
          message = (resObj.message as string) || exception.message;
          details = resObj.details !== undefined ? resObj.details : undefined;
        }

        if (resObj.code && typeof resObj.code === 'string') {
          errorCode = resObj.code;
        }
      }
    } else if (
      exception &&
      typeof exception === 'object' &&
      'code' in exception
    ) {
      const errorWithCode = exception as {
        code: string | number;
        message?: string;
        meta?: unknown;
        detail?: string;
        stack?: string;
      };
      const codeStr = String(errorWithCode.code);

      if (codeStr === 'P2002' || codeStr === '23505') {
        statusCode = HttpStatus.CONFLICT;
        errorCode = 'UNIQUE_CONSTRAINT_VIOLATION';
        message = 'A record with this identifier already exists';
        details = errorWithCode.meta || errorWithCode.detail;
      } else if (codeStr === 'P2025') {
        statusCode = HttpStatus.NOT_FOUND;
        errorCode = 'RECORD_NOT_FOUND';
        message = 'The requested resource was not found';
        details = errorWithCode.meta;
      } else if (codeStr === 'P2003' || codeStr === '23503') {
        statusCode = HttpStatus.BAD_REQUEST;
        errorCode = 'FOREIGN_KEY_CONSTRAINT_VIOLATION';
        message = 'Referenced related entity does not exist';
        details = errorWithCode.meta || errorWithCode.detail;
      } else if (codeStr === '22P02' || codeStr === 'P2023') {
        statusCode = HttpStatus.BAD_REQUEST;
        errorCode = 'INVALID_IDENTIFIER';
        message = 'Invalid input format or identifier type';
        details = errorWithCode.meta || errorWithCode.detail;
      } else if (codeStr === '23502' || codeStr === 'P2011') {
        statusCode = HttpStatus.BAD_REQUEST;
        errorCode = 'MISSING_REQUIRED_FIELD';
        message = 'A required field is missing';
        details = errorWithCode.meta || errorWithCode.detail;
      } else if (codeStr === 'P2000') {
        statusCode = HttpStatus.BAD_REQUEST;
        errorCode = 'VALUE_TOO_LONG';
        message = 'Provided value exceeds maximum allowed length';
        details = errorWithCode.meta;
      } else {
        this.logger.error(
          `[Unhandled Error with Code]: ${codeStr} - ${errorWithCode.message}`,
          errorWithCode.stack,
        );
        if (!isProduction) {
          message = errorWithCode.message || 'Database query error';
          details = { code: codeStr, meta: errorWithCode.meta, detail: errorWithCode.detail };
        }
      }
    } else if (exception instanceof Error) {
      this.logger.error(exception.stack || exception.message);
      message = isProduction
        ? 'An unexpected internal server error occurred'
        : exception.message;
      if (!isProduction) {
        details = { stack: exception.stack };
      }
    }

    const payload: ApiErrorEnvelope = {
      success: false,
      error: {
        code: errorCode,
        message,
        details,
      },
      statusCode,
      timestamp: new Date().toISOString(),
      path: request?.url,
    };

    response.status(statusCode).send(payload);
  }

  private mapStatusToErrorCode(status: number): string {
    switch (status) {
      case 400:
        return 'BAD_REQUEST';
      case 401:
        return 'UNAUTHORIZED';
      case 403:
        return 'FORBIDDEN';
      case 404:
        return 'NOT_FOUND';
      case 409:
        return 'CONFLICT';
      case 422:
        return 'UNPROCESSABLE_ENTITY';
      case 429:
        return 'RATE_LIMITED';
      default:
        return status >= 500 ? 'INTERNAL_SERVER_ERROR' : 'HTTP_ERROR';
    }
  }
}
