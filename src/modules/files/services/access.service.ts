import {
  ForbiddenException,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { classifyObjectKey } from '../domain/files.policy';
import { BlobRepository } from '../repositories/blob.repository';

/**
 * Self-contained Space/Blob RBAC policy & HMAC-SHA256 URL capability signer
 * for FilesModule (delegates DB membership lookups to BlobRepository).
 */
@Injectable()
export class FileAccessService {
  constructor(
    @Optional() private readonly blobRepo?: BlobRepository,
    @Optional() private readonly config?: ConfigService,
  ) {}

  async assertSpaceAccess(
    userId: string,
    spaceId?: string | null,
  ): Promise<void> {
    if (!spaceId || spaceId === userId || !this.blobRepo) {
      return;
    }

    const allowed = await this.blobRepo.hasUserAccessToSpace(userId, spaceId);
    if (!allowed) {
      throw new ForbiddenException('You do not have access to this space');
    }
  }

  async canAccessBlob(userId: string, blobId: string): Promise<boolean> {
    if (!userId || !blobId || !this.blobRepo) {
      return false;
    }
    return this.blobRepo.hasUserAccessToBlob(userId, blobId);
  }

  async assertBlobReadAccess(
    blobId: string,
    auth: {
      userId?: string;
      exp?: string;
      sig?: string;
      isDownload?: boolean;
    },
  ): Promise<void> {
    const hasValidSig = Boolean(
      auth.exp &&
      auth.sig &&
      this.verifyBlobSignature(blobId, auth.exp, auth.sig, {
        download: auth.isDownload,
      }),
    );
    if (hasValidSig) {
      return;
    }

    if (!auth.userId) {
      throw new UnauthorizedException(
        'Authentication or signed access token is required',
      );
    }

    if (this.blobRepo) {
      const allowed = await this.canAccessBlob(auth.userId, blobId);
      if (!allowed) {
        throw new ForbiddenException('You do not have access to this file');
      }
    }
  }

  resolveObjectAccess(
    rawKey: string,
    auth: { userId?: string; exp?: string; sig?: string },
  ): { key: string; isPublicAsset: boolean } {
    const { key, normalizedKey, isPublicAsset, isDerivative } =
      classifyObjectKey(rawKey);

    if (isDerivative) {
      const hasValidSig = this.verifyObjectSignature(
        normalizedKey,
        auth.exp,
        auth.sig,
      );
      if (!auth.userId && !hasValidSig) {
        throw new UnauthorizedException(
          'Authentication or signed access token is required',
        );
      }
    }

    return { key, isPublicAsset };
  }

  private getSecret(): string {
    return (
      this.config?.get<string>('STORAGE_HMAC_SECRET') ||
      this.config?.get<string>('JWT_SECRET') ||
      process.env.STORAGE_HMAC_SECRET ||
      process.env.JWT_SECRET ||
      'flux-files-signing-dev-secret'
    );
  }

  private sign(resource: string, expiresAtSec: number): string {
    return crypto
      .createHmac('sha256', this.getSecret())
      .update(`${resource}:${expiresAtSec}`)
      .digest('hex');
  }

  private verify(
    resource: string,
    expStr: string | undefined,
    sig: string | undefined,
  ): boolean {
    if (!expStr || !sig) {
      return false;
    }
    const expSec = Number(expStr);
    if (!Number.isFinite(expSec) || Math.floor(Date.now() / 1000) > expSec) {
      return false;
    }
    const expected = this.sign(resource, expSec);
    const sigBuf = Buffer.from(sig, 'utf8');
    const expBuf = Buffer.from(expected, 'utf8');
    if (sigBuf.length !== expBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(sigBuf, expBuf);
  }

  public signBlobUrl(
    blobId: string,
    options?: {
      expiresInSeconds?: number;
      filename?: string;
      download?: boolean;
    },
  ): string {
    const ttl = Math.max(10, Math.floor(options?.expiresInSeconds ?? 3600));
    const exp = Math.floor(Date.now() / 1000) + ttl;
    const downloadFlag = options?.download ? '1' : '0';
    const resource = `blob:${blobId}:dl=${downloadFlag}`;
    const sig = this.sign(resource, exp);

    const params = new URLSearchParams({
      exp: String(exp),
      sig,
    });
    if (options?.download) {
      params.set('download', '1');
    }
    if (options?.filename) {
      params.set('filename', options.filename);
    }
    return `/api/v1/files/${encodeURIComponent(blobId)}/content?${params.toString()}`;
  }

  public verifyBlobSignature(
    blobId: string,
    expStr: string | undefined,
    sig: string | undefined,
    options?: { download?: boolean },
  ): boolean {
    const downloadFlag = options?.download ? '1' : '0';
    return this.verify(`blob:${blobId}:dl=${downloadFlag}`, expStr, sig);
  }

  public signObjectUrl(key: string, expiresInSeconds = 3600): string {
    const ttl = Math.max(10, Math.floor(expiresInSeconds));
    const exp = Math.floor(Date.now() / 1000) + ttl;
    const sig = this.sign(`obj:${key}`, exp);
    return `/api/v1/files/objects/${encodeURIComponent(key)}?exp=${exp}&sig=${sig}`;
  }

  public verifyObjectSignature(
    key: string,
    expStr: string | undefined,
    sig: string | undefined,
  ): boolean {
    return this.verify(`obj:${key}`, expStr, sig);
  }
}
