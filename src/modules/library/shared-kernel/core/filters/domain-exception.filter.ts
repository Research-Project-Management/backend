import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { BaseDomainException } from '../errors/domain.exception';

/**
 * Clean Architecture Interface Adapter:
 * Maps pure domain exceptions to HTTP status codes at the presentation boundary.
 */
@Catch(BaseDomainException)
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: BaseDomainException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<FastifyReply>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    const exceptionName = exception.constructor.name;

    if (exceptionName.includes('NotFound')) {
      status = HttpStatus.NOT_FOUND;
    } else if (
      exceptionName.includes('Concurrency') ||
      exceptionName.includes('Conflict') ||
      exceptionName.includes('Duplicate') ||
      exceptionName.includes('Idempotency') ||
      exceptionName.includes('SsrfBlocked')
    ) {
      status = HttpStatus.CONFLICT;
    } else if (exceptionName.includes('TooLarge')) {
      status = HttpStatus.PAYLOAD_TOO_LARGE;
    } else if (
      exceptionName.includes('UnsupportedMedia') ||
      exceptionName.includes('UnsupportedSource')
    ) {
      status = HttpStatus.UNSUPPORTED_MEDIA_TYPE;
    } else if (
      exceptionName.includes('RateLimit') ||
      exceptionName.includes('ProviderUnavailable')
    ) {
      status = HttpStatus.TOO_MANY_REQUESTS;
    } else if (exceptionName.includes('Missing')) {
      status = HttpStatus.BAD_REQUEST;
    } else if (
      exceptionName.includes('Validation') ||
      exceptionName.includes('Invalid')
    ) {
      status = HttpStatus.UNPROCESSABLE_ENTITY;
    } else if (exceptionName.includes('Storage')) {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
    } else if ('category' in (exception as any)) {
      const category = (exception as any).category;
      switch (category) {
        case 'metadata_not_found':
          status = HttpStatus.NOT_FOUND;
          break;
        case 'duplicate_conflict':
        case 'idempotency_conflict':
          status = HttpStatus.CONFLICT;
          break;
        case 'provider_unavailable':
          status = HttpStatus.TOO_MANY_REQUESTS;
          break;
        case 'unsupported_source':
          status = HttpStatus.UNSUPPORTED_MEDIA_TYPE;
          break;
        case 'unauthorized':
          status = HttpStatus.UNAUTHORIZED;
          break;
        case 'forbidden':
          status = HttpStatus.FORBIDDEN;
          break;
        case 'validation_failed':
          status = HttpStatus.BAD_REQUEST;
          break;
        case 'storage_failed':
        default:
          status = HttpStatus.INTERNAL_SERVER_ERROR;
          break;
      }
    }

    this.logger.warn(
      `Domain Exception caught (${status}): ${exception.message}`,
    );

    response.status(status).send({
      statusCode: status,
      error: exceptionName,
      message: exception.message,
      timestamp: new Date().toISOString(),
    });
  }
}
