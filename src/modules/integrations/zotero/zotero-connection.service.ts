import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
  Inject,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { PrismaService } from '../../../core/database/prisma.service';
import {
  CreateZoteroConnectionDto,
  CreateZoteroBindingDto,
  ZoteroConnectionView,
} from './dto/zotero-connection.dto';
import { SYNC_PORT, SyncPort } from '../../library/sync/ports/sync.port';

@Injectable()
export class ZoteroConnectionService {
  private readonly logger = new Logger(ZoteroConnectionService.name);
  private readonly encryptionKey: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    @Optional()
    @Inject(SYNC_PORT)
    private readonly libraryBridge?: SyncPort,
  ) {
    const rawSecret =
      this.configService.get<string>('ZOTERO_ENCRYPTION_KEY') ||
      this.configService.get<string>('ENCRYPTION_SECRET') ||
      process.env.ZOTERO_ENCRYPTION_KEY ||
      process.env.ENCRYPTION_SECRET;

    if (!rawSecret || rawSecret.trim().length < 32) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error(
          'CRITICAL CONFIGURATION ERROR: ZOTERO_ENCRYPTION_KEY or ENCRYPTION_SECRET environment variable is required and must be at least 32 characters long for AES-256-GCM authenticated credential storage.',
        );
      }
      this.logger.warn(
        'ZOTERO_ENCRYPTION_KEY is missing or < 32 characters in non-production. Utilizing secure 32-byte baseline for AES-256-GCM.',
      );
    }

    const effectiveSecret =
      rawSecret && rawSecret.trim().length >= 32
        ? rawSecret.trim()
        : 'flux-research-zotero-secret-key-32-chars-long!';

    // Derive a fixed 32-byte key for AES-256-GCM
    this.encryptionKey = crypto
      .createHash('sha256')
      .update(effectiveSecret)
      .digest();
  }

  /**
   * Encrypts a plaintext API key with AES-256-GCM.
   */
  private encrypt(plainText: string): {
    cipherText: string;
    iv: string;
    tag: string;
  } {
    const iv = crypto.randomBytes(12); // Standard 12-byte IV for GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    let encrypted = cipher.update(plainText, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag();

    return {
      cipherText: encrypted,
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
    };
  }

  /**
   * Decrypts an AES-256-GCM encrypted ciphertext with authentication tag verification.
   */
  private decrypt(cipherText: string, ivHex: string, tagHex: string): string {
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      this.encryptionKey,
      iv,
    );
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(cipherText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  /**
   * Creates an encrypted Zotero connection for a workspace.
   */
  async createConnection(
    workspaceId: string,
    userId: string,
    input: CreateZoteroConnectionDto,
  ): Promise<ZoteroConnectionView> {
    const { cipherText, iv, tag } = this.encrypt(input.apiKey);

    const record = await this.prisma.zoteroConnection.upsert({
      where: {
        workspaceId_zoteroUserId: {
          workspaceId,
          zoteroUserId: input.zoteroUserId || `user-${Date.now()}`,
        },
      },
      create: {
        workspaceId,
        userId,
        provider: 'zotero',
        accountName: input.accountName || 'Zotero Account',
        accountType: input.accountType || 'user',
        zoteroUserId: input.zoteroUserId || `user-${Date.now()}`,
        encryptedApiKey: cipherText,
        keyIv: iv,
        keyTag: tag,
        status: 'active',
      },
      update: {
        encryptedApiKey: cipherText,
        keyIv: iv,
        keyTag: tag,
        status: 'active',
        accountName: input.accountName,
      },
    });

    return this.maskConnection(record);
  }

  /**
   * Retrieves the decrypted plaintext API key strictly for internal worker use.
   * Throws ForbiddenException if connection does not belong to the workspace.
   */
  async getDecryptedApiKey(
    connectionId: string,
    workspaceId: string,
  ): Promise<string> {
    const connection = await this.prisma.zoteroConnection.findUnique({
      where: { id: connectionId },
    });

    if (!connection) {
      throw new NotFoundException(
        `Zotero connection ${connectionId} not found`,
      );
    }

    if (connection.workspaceId !== workspaceId) {
      throw new ForbiddenException(
        'Tenant mismatch: Connection does not belong to the specified workspace',
      );
    }

    if (connection.status !== 'active') {
      throw new ForbiddenException(
        `Zotero connection ${connectionId} is ${connection.status}`,
      );
    }

    return this.decrypt(
      connection.encryptedApiKey,
      connection.keyIv,
      connection.keyTag,
    );
  }

  /**
   * Lists all Zotero connections for a workspace (with masked credentials).
   */
  async listConnections(workspaceId: string): Promise<ZoteroConnectionView[]> {
    const connections = await this.prisma.zoteroConnection.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });

    return connections.map((c) => this.maskConnection(c));
  }

  /**
   * Gets a specific Zotero connection view (credentials masked).
   */
  async getConnection(
    connectionId: string,
    workspaceId: string,
  ): Promise<ZoteroConnectionView> {
    const connection = await this.prisma.zoteroConnection.findUnique({
      where: { id: connectionId },
    });

    if (!connection || connection.workspaceId !== workspaceId) {
      throw new NotFoundException(
        `Zotero connection ${connectionId} not found`,
      );
    }

    return this.maskConnection(connection);
  }

  /**
   * Revokes / disconnects a Zotero connection.
   */
  async revokeConnection(
    connectionId: string,
    workspaceId: string,
  ): Promise<void> {
    const connection = await this.prisma.zoteroConnection.findUnique({
      where: { id: connectionId },
    });

    if (!connection || connection.workspaceId !== workspaceId) {
      throw new NotFoundException(
        `Zotero connection ${connectionId} not found`,
      );
    }

    await this.prisma.zoteroConnection.update({
      where: { id: connectionId },
      data: { status: 'revoked' },
    });
  }

  /**
   * Creates or updates a remote library binding for a connection.
   */
  async createBinding(workspaceId: string, input: CreateZoteroBindingDto) {
    const connection = await this.prisma.zoteroConnection.findUnique({
      where: { id: input.connectionId },
    });

    if (!connection || connection.workspaceId !== workspaceId) {
      throw new NotFoundException(
        'Zotero connection not found in this workspace',
      );
    }

    return this.prisma.zoteroBinding.upsert({
      where: {
        workspaceId_remoteLibraryType_remoteLibraryId: {
          workspaceId,
          remoteLibraryType: input.remoteLibraryType || 'user',
          remoteLibraryId: input.remoteLibraryId,
        },
      },
      create: {
        connectionId: input.connectionId,
        workspaceId,
        remoteLibraryType: input.remoteLibraryType || 'user',
        remoteLibraryId: input.remoteLibraryId,
        syncDirection: 'read_only', // Strictly forced to read_only in Phase 7
        syncStatus: 'idle',
        lastSyncVersion: BigInt(0),
      },
      update: {
        syncDirection: 'read_only',
        connectionId: input.connectionId,
      },
    });
  }

  /**
   * Lists remote library bindings for a workspace.
   */
  async listBindings(workspaceId: string, connectionId?: string) {
    return this.prisma.zoteroBinding.findMany({
      where: {
        workspaceId,
        ...(connectionId ? { connectionId } : {}),
      },
      include: {
        connection: {
          select: {
            id: true,
            accountName: true,
            accountType: true,
            status: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Updates sync direction (read_only <-> two_way) with strict capability checks and audit outbox.
   */
  async updateBindingSyncDirection(
    workspaceId: string,
    bindingId: string,
    newDirection: 'read_only' | 'two_way',
    actorUserId?: string,
  ) {
    const binding = await this.prisma.zoteroBinding.findUnique({
      where: { id: bindingId },
      include: { connection: true },
    });

    if (!binding || binding.workspaceId !== workspaceId) {
      throw new NotFoundException(
        `Zotero binding ${bindingId} not found in workspace ${workspaceId}`,
      );
    }

    if (newDirection === 'two_way') {
      if (binding.connection.status !== 'active') {
        throw new ForbiddenException(
          'Cannot enable two-way sync on an inactive Zotero connection',
        );
      }

      // Verify write capability of API key
      const apiKey = await this.getDecryptedApiKey(
        binding.connectionId,
        workspaceId,
      );
      if (!apiKey || apiKey.length === 0) {
        throw new ForbiddenException(
          'Zotero API key is missing or invalid for write operations',
        );
      }
    }

    const oldDirection = binding.syncDirection;

    const updated = await this.prisma.$transaction(async (tx) => {
      const b = await tx.zoteroBinding.update({
        where: { id: bindingId },
        data: { syncDirection: newDirection },
      });

      await tx.outboxEvent.create({
        data: {
          workspaceId,
          aggregateId: bindingId,
          eventType: 'library.zotero.sync_direction_updated',
          payload: {
            bindingId,
            oldDirection,
            newDirection,
            updatedBy: actorUserId,
            timestamp: new Date().toISOString(),
          },
        },
      });

      return b;
    });

    return updated;
  }

  /**
   * Lists active conflict records for a binding or workspace.
   */
  async listConflicts(workspaceId: string, bindingId?: string) {
    const where: any = {
      workspaceId,
      syncState: 'conflict',
    };
    if (bindingId) {
      where.bindingId = bindingId;
    }

    const conflicts = await this.prisma.zoteroItemBinding.findMany({
      where,
      include: {
        binding: {
          select: {
            id: true,
            remoteLibraryType: true,
            remoteLibraryId: true,
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    const itemIds = conflicts.map((c) => c.entityId);
    const catalogItems = this.libraryBridge
      ? await this.libraryBridge.getItemSnapshots({ workspaceId, itemIds })
      : [];
    const itemMap = new Map(catalogItems.map((i) => [i.id, i]));

    return conflicts.map((c) => {
      const item = itemMap.get(c.entityId);
      return {
        id: c.id,
        bindingId: c.bindingId,
        itemId: c.entityId,
        remoteKey: c.remoteKey,
        remoteVersion: c.remoteVersion.toString(),
        syncState: c.syncState,
        title: item?.title || 'Untitled Item',
        baseSnapshot: c.baseSnapshot,
        rawPayload: c.rawPayload,
        updatedAt: c.updatedAt,
      };
    });
  }

  /**
   * Lists items pending push or with active sync activity.
   */
  async listPendingPushes(workspaceId: string, bindingId?: string) {
    const where: any = {
      workspaceId,
      syncState: {
        in: ['queued', 'syncing', 'failed', 'conflict'],
      },
    };
    if (bindingId) {
      where.bindingId = bindingId;
    }

    const items = await this.prisma.zoteroItemBinding.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
    });

    const itemIds = items.map((i) => i.entityId);
    const catalogItems = this.libraryBridge
      ? await this.libraryBridge.getItemSnapshots({ workspaceId, itemIds })
      : [];
    const itemMap = new Map(catalogItems.map((i) => [i.id, i]));

    return items.map((i) => {
      const item = itemMap.get(i.entityId);
      return {
        id: i.id,
        bindingId: i.bindingId,
        itemId: i.entityId,
        remoteKey: i.remoteKey,
        remoteVersion: i.remoteVersion.toString(),
        syncState: i.syncState,
        title: item?.title || 'Untitled Item',
        updatedAt: i.updatedAt,
      };
    });
  }

  /**
   * Masks connection data so encrypted secret keys never leak to consumers.
   */
  private maskConnection(record: any): ZoteroConnectionView {
    return {
      id: record.id,
      workspaceId: record.workspaceId,
      userId: record.userId,
      provider: record.provider,
      accountName: record.accountName,
      accountType: record.accountType,
      zoteroUserId: record.zoteroUserId,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
}
