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
