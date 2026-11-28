import { PagesDomainError } from '@/modules/pages/core/domain/errors';

export class ZipSlipSecurityException extends PagesDomainError {
  constructor(entryPath: string) {
    super(
      `Security Violation: Zip entry '${entryPath}' contains illegal path traversal sequences.`,
      {
        code: 'ZIP_SLIP_DETECTED',
        statusCode: 403,
      },
    );
  }
}

export class ArchiveFileLimitExceededException extends PagesDomainError {
  constructor(maxFiles: number) {
    super(
      `ZIP archive exceeds the maximum project file limit of ${maxFiles.toLocaleString()} files.`,
      {
        code: 'ARCHIVE_FILE_LIMIT_EXCEEDED',
        statusCode: 400,
      },
    );
  }
}

export class InvalidZipArchiveException extends PagesDomainError {
  constructor(
    message = 'The provided archive is not a valid ZIP file or contains no usable entries.',
  ) {
    super(message, {
      code: 'INVALID_ZIP_ARCHIVE',
      statusCode: 400,
    });
  }
}

export class ArchiveSizeExceededException extends PagesDomainError {
  constructor(sizeBytes: number, maxBytes: number) {
    super(
      `Archive payload exceeds maximum allowed project uncompressed size of ${Math.round(maxBytes / (1024 * 1024))}MB. Found: ${Math.round(sizeBytes / (1024 * 1024))}MB.`,
      {
        code: 'ARCHIVE_SIZE_EXCEEDED',
        statusCode: 413,
      },
    );
  }
}
