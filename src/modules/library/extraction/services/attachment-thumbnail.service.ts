import {
  Injectable,
  NotFoundException,
  Inject,
  Optional,
} from '@nestjs/common';
import { STORAGE_PORT, IStoragePort } from '@/modules/storage/storage.port';

@Injectable()
export class AttachmentThumbnailService {
  constructor(
    @Optional()
    @Inject(STORAGE_PORT)
    private readonly storagePort?: IStoragePort,
  ) {}

  async getThumbnail(
    userId: string,
    attachmentId: string,
    fileId?: string | null,
    projectId?: string | null,
  ): Promise<{ buffer: Buffer; mimeType: string }> {
    if (!fileId || !this.storagePort) {
      throw new NotFoundException(
        `No PDF binary available for attachment ${attachmentId}`,
      );
    }

    const thumbBuffer = await this.storagePort.ensurePdfThumbnail({
      fileId,
      userId,
      projectId,
    });
    if (!thumbBuffer) {
      throw new NotFoundException(
        `Failed to generate thumbnail for attachment ${attachmentId}`,
      );
    }

    return {
      buffer: thumbBuffer,
      mimeType: 'image/webp',
    };
  }
}
