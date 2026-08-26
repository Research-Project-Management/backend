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
      // Prisma database errors
      const prismaError = exception as {
        code: string;
        message: string;
        meta?: unknown;
      };
      if (prismaError.code === 'P2002') {
        statusCode = HttpStatus.CONFLICT;
        errorCode = 'UNIQUE_CONSTRAINT_VIOLATION';
        message = 'A record with this identifier already exists';
        details = prismaError.meta;
      } else if (prismaError.code === 'P2025') {
        statusCode = HttpStatus.NOT_FOUND;
        errorCode = 'RECORD_NOT_FOUND';
        message = 'The requested resource was not found';
        details = prismaError.meta;
      } else if (prismaError.code === 'P2003') {
        statusCode = HttpStatus.BAD_REQUEST;
        errorCode = 'FOREIGN_KEY_CONSTRAINT_VIOLATION';
        message = 'Referenced related entity does not exist';
        details = prismaError.meta;
      } else {
        this.logger.error(
          `[Prisma Unhandled Error]: ${prismaError.code} - ${prismaError.message}`,
        );
      }
    } else if (exception instanceof Error) {
      this.logger.error(exception.stack);
      const isProduction = process.env.NODE_ENV === 'production';
      message = isProduction
        ? 'An unexpected internal server error occurred'
        : exception.message;
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
