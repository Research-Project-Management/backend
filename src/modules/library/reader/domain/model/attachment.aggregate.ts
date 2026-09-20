import { FileHashVo } from '../value-objects/file-hash.vo';
import { MimeTypeVo } from '../value-objects/mime-type.vo';
import {
  IContentDomainEvent,
  AttachmentCreatedDomainEvent,
  AttachmentRevisionAddedDomainEvent,
  AttachmentExtractedDomainEvent,
} from '../events/attachment-domain.event';

export interface CreateAttachmentProps {
  id?: string;
  itemId: string;
  filename: string;
  url: string;
  mimeType?: string | null;
  sizeBytes?: number;
  fileHash?: string | null;
}

export interface ReconstituteAttachmentProps {
  id: string;
  itemId: string;
  filename: string;
  url: string;
  mimeType: string;
  sizeBytes: number;
  fileHash?: string | null;
  revisionCount: number;
  isExtracted: boolean;
  pageCount?: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Attachment Aggregate Root (Content Bounded Context - Supporting Domain).
 *
 * Encapsulates:
 * - File attachment invariants (valid filename, url, size)
 * - Revision lifecycle tracking
 * - Text/metadata extraction status
 * - Content domain event collection
 */
export class AttachmentAggregate {
  private readonly _id: string;
  private readonly _itemId: string;
  private _filename: string;
  private _url: string;
  private readonly _mimeType: MimeTypeVo;
  private _sizeBytes: number;
  private _fileHash: FileHashVo | null;
  private _revisionCount: number;
  private _isExtracted: boolean;
  private _pageCount?: number | null;
  private readonly _createdAt: Date;
  private _updatedAt: Date;

  private _domainEvents: IContentDomainEvent[] = [];

  private constructor(props: {
    id: string;
    itemId: string;
    filename: string;
    url: string;
    mimeType: MimeTypeVo;
    sizeBytes: number;
    fileHash: FileHashVo | null;
    revisionCount: number;
    isExtracted: boolean;
    pageCount?: number | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    this._id = props.id;
    this._itemId = props.itemId;
    this._filename = props.filename;
    this._url = props.url;
    this._mimeType = props.mimeType;
    this._sizeBytes = props.sizeBytes;
    this._fileHash = props.fileHash;
    this._revisionCount = props.revisionCount;
    this._isExtracted = props.isExtracted;
    this._pageCount = props.pageCount;
    this._createdAt = props.createdAt;
    this._updatedAt = props.updatedAt;
  }

  public static create(props: CreateAttachmentProps): AttachmentAggregate {
    const trimmedFilename = props.filename?.trim();
    if (!trimmedFilename) {
      throw new Error('Attachment filename cannot be empty.');
    }

    const trimmedUrl = props.url?.trim();
    if (!trimmedUrl) {
      throw new Error('Attachment URL cannot be empty.');
    }

    const size = Math.max(0, props.sizeBytes ?? 0);
    const id = props.id ?? crypto.randomUUID();
    const mimeVo = MimeTypeVo.create(props.mimeType);
    const hashVo = props.fileHash ? FileHashVo.create(props.fileHash) : null;
    const now = new Date();

    const aggregate = new AttachmentAggregate({
      id,
      itemId: props.itemId,
      filename: trimmedFilename,
      url: trimmedUrl,
      mimeType: mimeVo,
      sizeBytes: size,
      fileHash: hashVo,
      revisionCount: 1,
      isExtracted: false,
      createdAt: now,
      updatedAt: now,
    });

    aggregate.recordEvent(
      new AttachmentCreatedDomainEvent(
        id,
        props.itemId,
        trimmedFilename,
        mimeVo.value,
        size,
      ),
    );

    return aggregate;
  }

  public static reconstitute(
    props: ReconstituteAttachmentProps,
  ): AttachmentAggregate {
    return new AttachmentAggregate({
      id: props.id,
      itemId: props.itemId,
      filename: props.filename,
      url: props.url,
      mimeType: MimeTypeVo.create(props.mimeType),
      sizeBytes: props.sizeBytes,
      fileHash: props.fileHash ? FileHashVo.create(props.fileHash) : null,
      revisionCount: props.revisionCount,
      isExtracted: props.isExtracted,
      pageCount: props.pageCount,
      createdAt: props.createdAt,
      updatedAt: props.updatedAt,
    });
  }

  // ── Business Methods ────────────────────────────────────────────────────────

  public addRevision(
    newUrl: string,
    sizeBytes: number,
    newHash?: string | null,
  ): void {
    const trimmed = newUrl.trim();
    if (!trimmed) throw new Error('Revision URL cannot be empty.');

    this._url = trimmed;
    this._sizeBytes = Math.max(0, sizeBytes);
    if (newHash) {
      this._fileHash = FileHashVo.create(newHash);
    }
    this._revisionCount += 1;
    this._updatedAt = new Date();

    this.recordEvent(
      new AttachmentRevisionAddedDomainEvent(
        this._id,
        this._itemId,
        this._revisionCount,
        this._sizeBytes,
      ),
    );
  }

  public markExtracted(pageCount: number): void {
    this._isExtracted = true;
    this._pageCount = pageCount;
    this._updatedAt = new Date();

    this.recordEvent(
      new AttachmentExtractedDomainEvent(this._id, this._itemId, pageCount),
    );
  }

  public rename(newFilename: string): void {
    const trimmed = newFilename.trim();
    if (!trimmed) throw new Error('Filename cannot be empty.');
    this._filename = trimmed;
    this._updatedAt = new Date();
  }

  // ── Domain Events ───────────────────────────────────────────────────────────

  private recordEvent(event: IContentDomainEvent): void {
    this._domainEvents.push(event);
  }

  public pullDomainEvents(): IContentDomainEvent[] {
    const events = [...this._domainEvents];
    this._domainEvents = [];
    return events;
  }

  // ── Getters ────────────────────────────────────────────────────────────────

  public get id(): string {
    return this._id;
  }
  public get itemId(): string {
    return this._itemId;
  }
  public get filename(): string {
    return this._filename;
  }
  public get url(): string {
    return this._url;
  }
  public get mimeType(): string {
    return this._mimeType.value;
  }
  public get isPdf(): boolean {
    return this._mimeType.isPdf;
  }
  public get sizeBytes(): number {
    return this._sizeBytes;
  }
  public get fileHash(): string | null {
    return this._fileHash?.value ?? null;
  }
  public get revisionCount(): number {
    return this._revisionCount;
  }
  public get isExtracted(): boolean {
    return this._isExtracted;
  }
  public get pageCount(): number | null | undefined {
    return this._pageCount;
  }
  public get createdAt(): Date {
    return this._createdAt;
  }
  public get updatedAt(): Date {
    return this._updatedAt;
  }
}
