/**
 * templates/domain/file.domain.ts
 * GoF Value Object + Factory Method (`TemplateFileVo`):
 * - `DOC`: UTF-8 LaTeX/BibTeX text hashed via SHA-256 (`TemplateBlob.textContent`).
 * - `FILE`: Zero-copy reference to platform CAS `FileBlob` (`blobId` + `storageKey` + `bucketName`),
 *   storing 0 binary bytes inside PostgreSQL.
 */

import { createHash } from 'node:crypto';
import { InvalidTemplateError } from './errors';
import {
  inferMimeType,
  MAX_TEMPLATE_FILE_BYTES,
  normalizeTemplatePath,
} from './policy';

export interface TemplateFileView {
  readonly path: string;
  readonly type: 'DOC' | 'FILE';
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly content?: string;
}

export interface BinaryAssetRefInput {
  readonly blobId?: string | null;
  readonly storageKey: string;
  readonly bucketName?: string | null;
  readonly contentHash: string;
  readonly mimeType?: string | null;
  readonly sizeBytes: number;
}

export class TemplateFileVo {
  private constructor(
    public readonly path: string,
    public readonly type: 'DOC' | 'FILE',
    public readonly mimeType: string,
    public readonly contentHash: string,
    public readonly sizeBytes: number,
    public readonly textContent: string | null,
    public readonly blobId: string | null,
    public readonly storageKey: string | null,
    public readonly bucketName: string | null,
  ) {}

  public static fromText(rawPath: string, text: string): TemplateFileVo {
    const path = normalizeTemplatePath(rawPath);
    const normalizedText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const buf = Buffer.from(normalizedText, 'utf8');
    if (buf.length > MAX_TEMPLATE_FILE_BYTES) {
      throw new InvalidTemplateError(
        `Template file "${path}" exceeds 50 MB limit`,
      );
    }
    const hash = createHash('sha256').update(buf).digest('hex');
    return new TemplateFileVo(
      path,
      'DOC',
      inferMimeType(path),
      hash,
      buf.length,
      normalizedText,
      null,
      null,
      null,
    );
  }

  public static fromAssetRef(
    rawPath: string,
    ref: BinaryAssetRefInput,
  ): TemplateFileVo {
    const path = normalizeTemplatePath(rawPath);
    if (ref.sizeBytes > MAX_TEMPLATE_FILE_BYTES) {
      throw new InvalidTemplateError(
        `Template asset "${path}" exceeds 50 MB limit`,
      );
    }
    const storageKey = ref.storageKey?.trim();
    if (!storageKey) {
      throw new InvalidTemplateError(
        `Template asset "${path}" requires a valid storageKey`,
      );
    }
    const cleanHash = ref.contentHash?.trim().toLowerCase();
    const contentHash =
      cleanHash && /^[0-9a-f]{64}$/.test(cleanHash)
        ? cleanHash
        : createHash('sha256').update(storageKey).digest('hex');

    return new TemplateFileVo(
      path,
      'FILE',
      ref.mimeType || inferMimeType(path),
      contentHash,
      Math.max(0, ref.sizeBytes),
      null,
      ref.blobId ?? null,
      storageKey,
      ref.bucketName || 'manuscript-files',
    );
  }

  public toView(): TemplateFileView {
    return {
      path: this.path,
      type: this.type,
      mimeType: this.mimeType,
      sizeBytes: this.sizeBytes,
      ...(this.type === 'DOC' ? { content: this.textContent ?? '' } : {}),
    };
  }
}
