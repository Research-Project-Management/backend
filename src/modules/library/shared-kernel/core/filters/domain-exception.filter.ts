import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { CatalogDomainException } from '../../../catalog/domain/exceptions/item-domain.exception';

/**
 * Clean Architecture Interface Adapter:
 * Maps pure domain exceptions to HTTP status codes at the presentation boundary.
 */
@Catch(CatalogDomainException)
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: CatalogDomainException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<FastifyReply>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    const exceptionName = exception.constructor.name;

    if (exceptionName.includes('NotFound')) {
      status = HttpStatus.NOT_FOUND;
    } else if (exceptionName.includes('Concurrency')) {
      status = HttpStatus.CONFLICT;
    } else if (
      exceptionName.includes('Validation') ||
      exceptionName.includes('Invalid')
    ) {
      status = HttpStatus.UNPROCESSABLE_ENTITY;
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
