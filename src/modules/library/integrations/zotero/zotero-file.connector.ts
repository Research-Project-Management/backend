import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { ZoteroSyncPolicy } from './zotero-sync-policy';

export interface StorageQuotaInfo {
  total: number;
  used: number;
  available: number;
  isExceeded: boolean;
  isUnavailable?: boolean;
}

export interface FileUploadResult {
  success: boolean;
  status: 'uploaded' | 'exists' | 'quota_exceeded' | 'failed';
  remoteKey: string;
  md5: string;
  sizeBytes: number;
  errorMessage?: string;
}

export interface FileDownloadResult {
  success: boolean;
  contentType: string;
  filename: string;
  sizeBytes: number;
  buffer?: Buffer;
  md5?: string;
  errorMessage?: string;
}

@Injectable()
export class ZoteroFileConnector {
  private readonly logger = new Logger(ZoteroFileConnector.name);
  private readonly baseUrl = 'https://api.zotero.org';
  private readonly maxFileSize = 50 * 1024 * 1024; // 50MB maximum attachment size

  constructor(private readonly syncPolicy: ZoteroSyncPolicy) {}

  /**
   * Retrieves the current storage quota for a user/group library.
   */
  async getStorageQuota(
    apiKey: string,
    userId: string,
  ): Promise<StorageQuotaInfo> {
    try {
      const res = await fetch(`${this.baseUrl}/users/${userId}/storage`, {
        headers: {
          'Zotero-API-Version': '3',
          'Zotero-API-Key': apiKey,
        },
      });

      if (!res.ok) {
        return {
          total: 0,
          used: 0,
          available: 0,
          isExceeded: false,
          isUnavailable: true,
        };
      }

      const data = await res.json();
      const total = Number(data.total || 0);
      const used = Number(data.used || 0);
      const available = Math.max(total - used, 0);

      return {
        total,
        used,
        available,
        isExceeded: total > 0 && used >= total,
        isUnavailable: false,
      };
    } catch (err: any) {
      this.logger.warn(`Failed to fetch Zotero storage quota: ${err.message}`);
      return {
        total: 0,
        used: 0,
        available: 0,
        isExceeded: false,
        isUnavailable: true,
      };
    }
  }

  /**
   * Downloads a binary attachment from Zotero Storage.
   */
  async downloadAttachment(
    apiKey: string,
    libraryType: 'user' | 'group',
    libraryId: string,
    itemKey: string,
  ): Promise<FileDownloadResult> {
    const prefix =
      libraryType === 'user' ? `/users/${libraryId}` : `/groups/${libraryId}`;
    const endpoint = `${this.baseUrl}${prefix}/items/${itemKey}/file`;

    try {
      const res = await fetch(endpoint, {
        headers: {
          'Zotero-API-Version': '3',
          'Zotero-API-Key': apiKey,
        },
      });

      if (res.status === 404) {
        return {
          success: false,
          contentType: '',
          filename: '',
          sizeBytes: 0,
          errorMessage: 'Remote attachment file not found in Zotero Storage',
        };
      }

      if (!res.ok) {
        throw new Error(
          `Zotero file download failed (${res.status}): ${res.statusText}`,
        );
      }

      const contentType =
        res.headers.get('Content-Type') || 'application/octet-stream';
      const contentDisposition = res.headers.get('Content-Disposition') || '';
      const filenameMatch = contentDisposition.match(/filename="?([^";]+)"?/);
      const filename = filenameMatch ? filenameMatch[1] : `${itemKey}.pdf`;

      const arrayBuffer = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const md5 = crypto.createHash('md5').update(buffer).digest('hex');

      return {
        success: true,
        contentType,
        filename,
        sizeBytes: buffer.length,
        buffer,
        md5,
      };
    } catch (err: any) {
      this.logger.error(
        `Failed to download attachment ${itemKey}: ${err.message}`,
      );
      return {
        success: false,
        contentType: '',
        filename: '',
        sizeBytes: 0,
        errorMessage: err.message,
      };
    }
  }

  /**
   * Uploads a local attachment to Zotero Storage using standard 2-step upload protocol.
   */
  async uploadAttachment(
    apiKey: string,
    libraryType: 'user' | 'group',
    libraryId: string,
    itemKey: string,
    fileBuffer: Buffer,
    filename: string,
    contentType = 'application/pdf',
  ): Promise<FileUploadResult> {
    if (fileBuffer.length > this.maxFileSize) {
      return {
        success: false,
        status: 'failed',
        remoteKey: itemKey,
        md5: '',
        sizeBytes: fileBuffer.length,
        errorMessage: `File size ${fileBuffer.length} bytes exceeds maximum allowed ${this.maxFileSize} bytes`,
      };
    }

    const md5 = crypto.createHash('md5').update(fileBuffer).digest('hex');
    const prefix =
      libraryType === 'user' ? `/users/${libraryId}` : `/groups/${libraryId}`;

    // Step 1: Request upload authorization
    const authEndpoint = `${this.baseUrl}${prefix}/items/${itemKey}/file`;

    try {
      const authRes = await fetch(authEndpoint, {
        method: 'POST',
        headers: {
          'Zotero-API-Version': '3',
          'Zotero-API-Key': apiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
          'If-None-Match': md5,
        },
        body: new URLSearchParams({
          md5,
          filename,
          filesize: String(fileBuffer.length),
          mtime: String(Date.now()),
          contentType,
        }),
      });

      // 304 Not Modified -> file with exact MD5 already exists on Zotero Storage!
      if (authRes.status === 304) {
        return {
          success: true,
          status: 'exists',
          remoteKey: itemKey,
          md5,
          sizeBytes: fileBuffer.length,
        };
      }

      if (authRes.status === 413) {
        return {
          success: false,
          status: 'quota_exceeded',
          remoteKey: itemKey,
          md5,
          sizeBytes: fileBuffer.length,
          errorMessage: 'Zotero storage quota exceeded',
        };
      }

      if (!authRes.ok) {
        throw new Error(
          `Zotero upload authorization failed (${authRes.status}): ${authRes.statusText}`,
        );
      }

      const authData = await authRes.json();

      // If upload was already complete (exists)
      if (authData.exists === 1) {
        return {
          success: true,
          status: 'exists',
          remoteKey: itemKey,
          md5,
          sizeBytes: fileBuffer.length,
        };
      }

      // Step 2: Upload file bytes to provided S3 / Storage URL
      const uploadUrl = authData.url;
      const uploadHeaders: Record<string, string> = {
        'Content-Type': authData.contentType || contentType,
      };

      const uploadRes = await fetch(uploadUrl, {
        method: 'POST',
        headers: uploadHeaders,
        body: new Uint8Array(fileBuffer) as any,
      });

      if (
        !uploadRes.ok &&
        uploadRes.status !== 200 &&
        uploadRes.status !== 201 &&
        uploadRes.status !== 204
      ) {
        throw new Error(
          `Binary upload to Zotero storage endpoint failed with status ${uploadRes.status}`,
        );
      }

      // Step 3: Register upload completion with upload token
      if (authData.uploadKey) {
        const registerRes = await fetch(authEndpoint, {
          method: 'POST',
          headers: {
            'Zotero-API-Version': '3',
            'Zotero-API-Key': apiKey,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            upload: authData.uploadKey,
          }),
        });

        if (!registerRes.ok && registerRes.status !== 204) {
          this.logger.warn(
            `Upload registration returned status ${registerRes.status}`,
          );
        }
      }

      return {
        success: true,
        status: 'uploaded',
        remoteKey: itemKey,
        md5,
        sizeBytes: fileBuffer.length,
      };
    } catch (err: any) {
      this.logger.error(
        `Zotero attachment upload failed for item ${itemKey}: ${err.message}`,
      );
      return {
        success: false,
        status: 'failed',
        remoteKey: itemKey,
        md5,
        sizeBytes: fileBuffer.length,
        errorMessage: err.message,
      };
    }
  }
}
