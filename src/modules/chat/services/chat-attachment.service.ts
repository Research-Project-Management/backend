import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import * as path from 'path';
import { STORAGE_ADAPTER } from '@/modules/files/files.constant';
import { IStorageAdapter } from '@/modules/files/types/adapter.type';
import { sanitizeFilename } from '@/modules/files/domain/files.policy';
import { ChatService } from './chat.service';
import {
  MAX_CHAT_IMAGE_BYTES,
  MAX_CHAT_FILE_BYTES,
  PRESIGNED_UPLOAD_EXPIRES_SECONDS,
  PRESIGNED_DOWNLOAD_EXPIRES_SECONDS,
  BLOCKED_CHAT_EXTENSIONS,
} from '../chat.constant';
import {
  PresignChatAttachmentDto,
  CompleteChatAttachmentDto,
} from '../dto/attachment.dto';

export interface ChatAttachmentResult {
  id: string;
  name: string;
  url: string;
  storageKey: string;
  size: number;
  mimeType: string;
  type: 'image' | 'file';
  thumbnailUrl?: string;
}

@Injectable()
export class ChatAttachmentService {
  private readonly logger = new Logger(ChatAttachmentService.name);
  private readonly publicBaseUrl: string | null;

  constructor(
    @Inject(STORAGE_ADAPTER) private readonly storageAdapter: IStorageAdapter,
    private readonly chatService: ChatService,
    private readonly config: ConfigService,
  ) {
    const pubUrl =
      this.config.get<string>('R2_PUBLIC_URL') ||
      this.config.get<string>('CLOUDFLARE_R2_PUBLIC_URL') ||
      this.config.get<string>('S3_PUBLIC_URL') ||
      '';
    this.publicBaseUrl = pubUrl ? pubUrl.replace(/\/+$/, '') : null;
  }

  /**
   * Validate file size and security extension rules.
   */
  public validateAttachmentLimits(
    filename: string,
    sizeBytes: number,
    mimeType?: string,
  ): { cleanFilename: string; isImage: boolean; resolvedMime: string } {
    if (!sizeBytes || sizeBytes <= 0) {
      throw new BadRequestException('File size must be greater than 0');
    }

    const cleanFilename = sanitizeFilename(filename);
    const ext = path.extname(cleanFilename).toLowerCase();
    if (BLOCKED_CHAT_EXTENSIONS.has(ext)) {
      throw new BadRequestException(
        `File extension "${ext}" is blocked for security reasons`,
      );
    }

    const isImage =
      (mimeType && mimeType.startsWith('image/')) ||
      /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(cleanFilename);

    if (isImage) {
      if (sizeBytes > MAX_CHAT_IMAGE_BYTES) {
        const maxMb = MAX_CHAT_IMAGE_BYTES / (1024 * 1024);
        throw new PayloadTooLargeException(
          `Image size (${(sizeBytes / (1024 * 1024)).toFixed(1)}MB) exceeds maximum limit of ${maxMb}MB`,
        );
      }
    } else {
      if (sizeBytes > MAX_CHAT_FILE_BYTES) {
        const maxMb = MAX_CHAT_FILE_BYTES / (1024 * 1024);
        throw new PayloadTooLargeException(
          `File size (${(sizeBytes / (1024 * 1024)).toFixed(1)}MB) exceeds maximum limit of ${maxMb}MB`,
        );
      }
    }

    const resolvedMime =
      mimeType && mimeType !== 'application/octet-stream'
        ? mimeType
        : isImage
          ? ext === '.png'
            ? 'image/png'
            : ext === '.gif'
              ? 'image/gif'
              : ext === '.webp'
                ? 'image/webp'
                : ext === '.svg'
                  ? 'image/svg+xml'
                  : 'image/jpeg'
          : 'application/octet-stream';

    return { cleanFilename, isImage, resolvedMime };
  }

  /**
   * Generate partition-optimized Cloudflare R2 storage key.
   * Format: chat/{conversationId}/{YYYY}/{MM}/{uuid}-{sanitizedFilename}
   */
  public generateStorageKey(conversationId: string, filename: string): string {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const fileUuid = crypto.randomUUID();
    const cleanFilename = sanitizeFilename(filename);
    return `chat/${conversationId}/${year}/${month}/${fileUuid}-${cleanFilename}`;
  }

  /**
   * Step 1: Issue direct-to-R2 presigned upload URL for massive scalability.
   * Client uploads directly to Cloudflare R2, bypassing backend CPU and network.
   */
  async createPresignedUpload(
    conversationId: string,
    userId: string,
    dto: PresignChatAttachmentDto,
  ) {
    // 1. Authorize user membership in conversation
    await this.chatService.verifyConversationAccess(conversationId, userId);

    // 2. Validate per-file size limit & safe extension
    const { cleanFilename, isImage, resolvedMime } =
      this.validateAttachmentLimits(dto.filename, dto.sizeBytes, dto.mimeType);

    // 3. Generate partitioned R2 key
    const storageKey = this.generateStorageKey(conversationId, cleanFilename);

    // 4. Request signed PUT URL from R2/S3 adapter
    const uploadUrl = await this.storageAdapter.getPresignedUploadUrl(
      storageKey,
      {
        mimeType: resolvedMime,
        expiresInSeconds: PRESIGNED_UPLOAD_EXPIRES_SECONDS,
      },
    );

    return {
      uploadUrl,
      storageKey,
      filename: cleanFilename,
      sizeBytes: dto.sizeBytes,
      mimeType: resolvedMime,
      maxSizeBytes: isImage ? MAX_CHAT_IMAGE_BYTES : MAX_CHAT_FILE_BYTES,
      expiresIn: PRESIGNED_UPLOAD_EXPIRES_SECONDS,
      type: isImage ? 'image' : 'file',
    };
  }

  /**
   * Step 2: Finalize and verify presigned upload, returning rich attachment metadata.
   */
  async completePresignedUpload(
    conversationId: string,
    userId: string,
    dto: CompleteChatAttachmentDto,
  ): Promise<ChatAttachmentResult> {
    // 1. Authorize user membership
    await this.chatService.verifyConversationAccess(conversationId, userId);

    // 2. Validate storage key namespace matches this conversation
    const expectedPrefix = `chat/${conversationId}/`;
    if (!dto.storageKey.startsWith(expectedPrefix)) {
      throw new ForbiddenException(
        'Invalid storage key for this conversation room',
      );
    }

    // 3. Validate limits
    const { cleanFilename, isImage, resolvedMime } =
      this.validateAttachmentLimits(dto.filename, dto.sizeBytes, dto.mimeType);

    // 4. Resolve download/access URL
    const url = this.publicBaseUrl
      ? `${this.publicBaseUrl}/${dto.storageKey}`
      : `/api/chat/attachments/stream?key=${encodeURIComponent(dto.storageKey)}`;

    return {
      id: crypto.randomUUID(),
      name: cleanFilename,
      url,
      storageKey: dto.storageKey,
      size: dto.sizeBytes,
      mimeType: resolvedMime,
      type: isImage ? 'image' : 'file',
    };
  }

  /**
   * Direct fallback upload for environments unable to reach R2 directly.
   */
  async uploadDirect(
    conversationId: string,
    userId: string,
    file: { buffer: Buffer; filename: string; mimeType?: string },
  ): Promise<ChatAttachmentResult> {
    await this.chatService.verifyConversationAccess(conversationId, userId);

    const { cleanFilename, isImage, resolvedMime } =
      this.validateAttachmentLimits(
        file.filename,
        file.buffer.length,
        file.mimeType,
      );

    const storageKey = this.generateStorageKey(conversationId, cleanFilename);

    await this.storageAdapter.put(storageKey, file.buffer, {
      mimeType: resolvedMime,
      size: file.buffer.length,
    });

    const url = this.publicBaseUrl
      ? `${this.publicBaseUrl}/${storageKey}`
      : `/api/chat/attachments/stream?key=${encodeURIComponent(storageKey)}`;

    return {
      id: crypto.randomUUID(),
      name: cleanFilename,
      url,
      storageKey,
      size: file.buffer.length,
      mimeType: resolvedMime,
      type: isImage ? 'image' : 'file',
    };
  }

  /**
   * Stream or redirect to direct presigned R2 GET URL for authenticated users.
   */
  async resolveAttachmentAccess(
    userId: string,
    storageKey: string,
    options?: {
      download?: boolean;
      filename?: string;
      range?: { start: number; end: number };
    },
  ) {
    if (!storageKey.startsWith('chat/')) {
      throw new BadRequestException('Invalid chat storage key');
    }

    const segments = storageKey.split('/');
    if (segments.length < 5) {
      throw new BadRequestException('Malformed chat storage key');
    }

    const conversationId = segments[1];
    await this.chatService.verifyConversationAccess(conversationId, userId);

    // 1. If public CDN URL is configured, redirect directly
    if (this.publicBaseUrl) {
      return {
        kind: 'redirect' as const,
        url: `${this.publicBaseUrl}/${storageKey}`,
      };
    }

    // 2. Otherwise generate direct Cloudflare R2 Presigned Download URL (0 backend egress!)
    try {
      const presignedGet = await this.storageAdapter.getPresignedDownloadUrl(
        storageKey,
        {
          filename: options?.filename || path.basename(storageKey),
          expiresInSeconds: PRESIGNED_DOWNLOAD_EXPIRES_SECONDS,
        },
      );
      return { kind: 'redirect' as const, url: presignedGet };
    } catch {
      // 3. Fallback to server stream if presign is unavailable (e.g. local driver)
      const streamRes = await this.storageAdapter.getStream(
        storageKey,
        options?.range,
      );
      const isImage = /\.(png|jpe?g|gif|webp|svg)$/i.test(storageKey);
      return {
        kind: 'stream' as const,
        stream: streamRes.stream,
        contentLength: streamRes.contentLength,
        contentRange: streamRes.contentRange,
        mimeType: isImage ? 'image/jpeg' : 'application/octet-stream',
        filename: path.basename(storageKey),
      };
    }
  }
}
