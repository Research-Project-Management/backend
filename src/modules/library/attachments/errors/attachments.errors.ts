import { HttpException, HttpStatus } from '@nestjs/common';

export class AttachmentTooLargeException extends HttpException {
  constructor(size: number, limit: number) {
    super(
      `File size (${size} bytes) exceeds maximum limit (${limit} bytes)`,
      HttpStatus.PAYLOAD_TOO_LARGE,
    );
  }
}

export class InvalidAttachmentTypeException extends HttpException {
  constructor(mimeType: string) {
    super(
      `MIME type "${mimeType}" is not an allowed attachment format`,
      HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    );
  }
}

export class MissingAttachmentFileException extends HttpException {
  constructor() {
    super('No file uploaded or provided', HttpStatus.BAD_REQUEST);
  }
}

export class AttachmentStorageException extends HttpException {
  constructor(message: string) {
    super(message, HttpStatus.INTERNAL_SERVER_ERROR);
  }
}
