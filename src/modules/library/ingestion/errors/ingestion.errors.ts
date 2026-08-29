import {
  HttpException,
  HttpStatus,
  BadRequestException,
  NotFoundException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';

export type IngestionErrorCategory =
  | 'validation_failed'
  | 'unsupported_source'
  | 'metadata_not_found'
  | 'provider_unavailable'
  | 'duplicate_conflict'
  | 'idempotency_conflict'
  | 'storage_failed'
  | 'extraction_failed'
  | 'indexing_failed'
  | 'unauthorized'
  | 'forbidden';

export class IngestionException extends HttpException {
  public readonly category: IngestionErrorCategory;

  constructor(
    message: string,
    category: IngestionErrorCategory,
    statusCode: HttpStatus = HttpStatus.BAD_REQUEST,
  ) {
    super(
      {
        statusCode,
        errorCategory: category,
        message,
      },
      statusCode,
    );
    this.category = category;
  }
}

export class IngestionValidationException extends BadRequestException {
  public readonly category: IngestionErrorCategory = 'validation_failed';

  constructor(message: string) {
    super({
      statusCode: HttpStatus.BAD_REQUEST,
      errorCategory: 'validation_failed',
      message,
    });
  }
}

export class IngestionUnsupportedSourceException extends BadRequestException {
  public readonly category: IngestionErrorCategory = 'unsupported_source';

  constructor(source: string) {
    super({
      statusCode: HttpStatus.BAD_REQUEST,
      errorCategory: 'unsupported_source',
      message: `Unsupported ingestion source: ${source}`,
    });
  }
}

export class IngestionMetadataNotFoundException extends NotFoundException {
  public readonly category: IngestionErrorCategory = 'metadata_not_found';

  constructor(query: string) {
    super({
      statusCode: HttpStatus.NOT_FOUND,
      errorCategory: 'metadata_not_found',
      message: `Metadata not found for query: ${query}`,
    });
  }
}

export class IngestionIdempotencyConflictException extends ConflictException {
  public readonly category: IngestionErrorCategory = 'idempotency_conflict';

  constructor(
    message = 'Idempotency key reused with mismatched payload or request already in progress',
  ) {
    super({
      statusCode: HttpStatus.CONFLICT,
      errorCategory: 'idempotency_conflict',
      message,
    });
  }
}

export class IngestionDuplicateConflictException extends ConflictException {
  public readonly category: IngestionErrorCategory = 'duplicate_conflict';

  constructor(message: string) {
    super({
      statusCode: HttpStatus.CONFLICT,
      errorCategory: 'duplicate_conflict',
      message,
    });
  }
}

export class IngestionStorageException extends InternalServerErrorException {
  public readonly category: IngestionErrorCategory = 'storage_failed';

  constructor(message: string, options?: { cause?: unknown }) {
    super(
      {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        errorCategory: 'storage_failed',
        message,
      },
      options,
    );
  }
}

export class IngestionRateLimitException extends HttpException {
  public readonly category: IngestionErrorCategory = 'provider_unavailable';

  constructor(
    message = 'Upstream provider rate limit exceeded, please retry later',
  ) {
    super(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        errorCategory: 'provider_unavailable',
        message,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
