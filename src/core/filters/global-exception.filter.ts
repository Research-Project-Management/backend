import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<FastifyReply>();

    // If headers or reply were already sent (e.g. streaming SSE, R2 file streaming aborted by client), skip sending duplicate reply
    if (response.sent || response.raw?.headersSent) {
      this.logger.warn(
        `[GlobalExceptionFilter] Reply already sent or connection closed. Suppressed: ${
          exception instanceof Error ? exception.message : String(exception)
        }`,
      );
      return;
    }

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: unknown = 'Internal server error';
    let details: unknown = undefined;

    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === 'string') {
        message = res;
      } else if (typeof res === 'object' && res !== null) {
        const resObj = res as Record<string, unknown>;
        message = resObj.message || exception.message;
        details = resObj.details || resObj.error;
      }
    } else if (exception instanceof Error) {
      message = exception.message;
      this.logger.error(exception.stack);
    }

    response.status(statusCode).send({
      statusCode,
      message: Array.isArray(message) ? message[0] : message,
      errors: Array.isArray(message) ? message : undefined,
      details,
      timestamp: new Date().toISOString(),
    });
  }
}
