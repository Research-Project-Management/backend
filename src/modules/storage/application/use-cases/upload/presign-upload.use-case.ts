import { Injectable, Inject, BadRequestException } from '@nestjs/common';
import * as crypto from 'crypto';
import { STORAGE_DRIVER } from '../../../storage.tokens';
import { IStorageDriver } from '../../../domain/ports/storage-driver.port';

import {
  isBlockedExtension,
  sanitizeFilename,
} from '../../../domain/value-objects/file-validator.util';

export interface PresignUploadInput {
  userId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface PresignUploadOutput {
  uploadUrl: string;
  storageKey: string;
  fileUuid: string;
  expiresIn: number;
}

@Injectable()
export class PresignUploadUseCase {
  constructor(
    @Inject(STORAGE_DRIVER) private readonly driver: IStorageDriver,
  ) {}

  async execute(input: PresignUploadInput): Promise<PresignUploadOutput> {
    if (isBlockedExtension(input.filename)) {
      throw new BadRequestException(
        'File extension is prohibited for security reasons',
      );
    }

    const MAX_SINGLE_UPLOAD = 100 * 1024 * 1024; // 100MB
    if (input.sizeBytes > MAX_SINGLE_UPLOAD) {
      throw new BadRequestException(
        'Files larger than 100MB must use multipart upload',
      );
    }

    const fileUuid = crypto.randomUUID();
    const cleanExt = (input.filename.split('.').pop() || 'bin').replace(
      /[^a-zA-Z0-9]/g,
      '',
    );
    const storageKey = `uploads/${input.userId}/${fileUuid}.${cleanExt}`;

    const uploadUrl = await this.driver.getPresignedUploadUrl(storageKey, {
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      expiresInSeconds: 300, // 5 minutes
    });

    return {
      uploadUrl,
      storageKey,
      fileUuid,
      expiresIn: 300,
    };
  }
}
