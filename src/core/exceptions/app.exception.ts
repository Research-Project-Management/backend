import { HttpException, HttpStatus } from '@nestjs/common';

export class AppException extends HttpException {
  constructor(
    message: string,
    statusCode: HttpStatus = HttpStatus.BAD_REQUEST,
    public readonly details?: unknown,
  ) {
    super(
      {
        statusCode,
        message,
        details,
        timestamp: new Date().toISOString(),
      },
      statusCode,
    );
  }
}
