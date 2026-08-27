export interface FileValidationResult {
  isValid: boolean;
  error?: string;
  detectedMime?: string;
  sizeBytes?: number;
}

export function validatePdfBuffer(
  buffer: Buffer,
  maxSizeBytes: number = 100 * 1024 * 1024,
): FileValidationResult {
  if (!buffer || buffer.length === 0) {
    return { isValid: false, error: 'File buffer is empty' };
  }

  if (buffer.length > maxSizeBytes) {
    return {
      isValid: false,
      error: `File size ${buffer.length} exceeds maximum permitted limit of ${maxSizeBytes} bytes`,
      sizeBytes: buffer.length,
    };
  }

  if (buffer.length >= 2 && buffer[0] === 0x4d && buffer[1] === 0x5a) {
    return {
      isValid: false,
      error: 'Security violation: Windows PE/MZ executable detected',
    };
  }

  if (
    buffer.length >= 4 &&
    buffer[0] === 0x7f &&
    buffer[1] === 0x45 &&
    buffer[2] === 0x4c &&
    buffer[3] === 0x46
  ) {
    return {
      isValid: false,
      error: 'Security violation: Linux ELF executable detected',
    };
  }

  if (
    buffer.length >= 4 &&
    buffer[0] === 0xca &&
    buffer[1] === 0xfe &&
    buffer[2] === 0xba &&
    buffer[3] === 0xbe
  ) {
    return {
      isValid: false,
      error: 'Security violation: Mach-O/Java bytecode binary detected',
    };
  }

  const headerSlice = buffer.subarray(0, 1024).toString('utf8').toLowerCase();
  if (
    headerSlice.includes('<?php') ||
    headerSlice.includes('<script') ||
    headerSlice.startsWith('#!/bin/') ||
    headerSlice.startsWith('#!/usr/bin/')
  ) {
    return {
      isValid: false,
      error: 'Security violation: Script payload detected in file header',
    };
  }

  const magic = buffer.subarray(0, 5).toString('ascii');
  if (magic !== '%PDF-') {
    return {
      isValid: false,
      error: `Invalid PDF format: expected magic '%PDF-', found '${magic}'`,
    };
  }

  return {
    isValid: true,
    detectedMime: 'application/pdf',
    sizeBytes: buffer.length,
  };
}

export class FileSecurityValidator {
  validatePdfBuffer(
    buffer: Buffer,
    maxSizeBytes?: number,
  ): FileValidationResult {
    const result = validatePdfBuffer(buffer, maxSizeBytes);

    if (!result.isValid && result.error?.startsWith('Invalid PDF format:')) {
      return {
        ...result,
        error: `${result.error}; file does not contain valid PDF magic bytes`,
      };
    }

    if (
      !result.isValid &&
      result.error ===
        'Security violation: Script payload detected in file header'
    ) {
      return {
        ...result,
        error:
          'Security violation: active script polyglot detected in file header',
      };
    }

    return result;
  }
}
