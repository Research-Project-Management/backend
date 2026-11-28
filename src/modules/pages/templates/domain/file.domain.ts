/**
 * templates/domain/file.domain.ts
 * GoF Value Object + Factory Method (`TemplateFileVo`) for content-addressable
 * UTF-8 LaTeX documents and binary assets (`.png`, `.pdf`, `.ttf`, `.otf`).
 */

import { createHash } from 'node:crypto';
import { isTextPath } from '@/modules/pages/core/domain/text-extensions';
import { InvalidTemplateError } from './errors';
import {
  inferMimeType,
  MAX_TEMPLATE_FILE_BYTES,
  normalizeTemplatePath,
} from './policy';

export interface TemplateFileView {
  readonly path: string;
  readonly kind: 'doc' | 'file';
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly content?: string;
  readonly base64?: string;
}

export class TemplateFileVo {
  private constructor(
    public readonly path: string,
    public readonly kind: 'doc' | 'file',
    public readonly mimeType: string,
    public readonly contentHash: string,
    public readonly sizeBytes: number,
    public readonly textContent: string | null,
    public readonly binaryData: Buffer | null,
  ) {}

  public static fromText(rawPath: string, text: string): TemplateFileVo {
    const path = normalizeTemplatePath(rawPath);
    const normalizedText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const buf = Buffer.from(normalizedText, 'utf8');
    if (buf.length > MAX_TEMPLATE_FILE_BYTES) {
      throw new InvalidTemplateError(
        `Template file "${path}" exceeds 25 MB limit`,
      );
    }
    const hash = createHash('sha256').update(buf).digest('hex');
    return new TemplateFileVo(
      path,
      'doc',
      inferMimeType(path),
      hash,
      buf.length,
      normalizedText,
      null,
    );
  }

  public static fromBuffer(
    rawPath: string,
    buf: Buffer,
    explicitMime?: string,
  ): TemplateFileVo {
    const path = normalizeTemplatePath(rawPath);
    if (buf.length > MAX_TEMPLATE_FILE_BYTES) {
      throw new InvalidTemplateError(
        `Template file "${path}" exceeds 25 MB limit`,
      );
    }
    if (isTextPath(`/${path}`, buf)) {
      return TemplateFileVo.fromText(path, buf.toString('utf8'));
    }
    const hash = createHash('sha256').update(buf).digest('hex');
    return new TemplateFileVo(
      path,
      'file',
      explicitMime || inferMimeType(path),
      hash,
      buf.length,
      null,
      buf,
    );
  }

  public toBuffer(): Buffer {
    return this.binaryData ?? Buffer.from(this.textContent ?? '', 'utf8');
  }

  public toView(): TemplateFileView {
    return {
      path: this.path,
      kind: this.kind,
      mimeType: this.mimeType,
      sizeBytes: this.sizeBytes,
      ...(this.kind === 'doc'
        ? { content: this.textContent ?? '' }
        : { base64: (this.binaryData ?? Buffer.alloc(0)).toString('base64') }),
    };
  }
}
