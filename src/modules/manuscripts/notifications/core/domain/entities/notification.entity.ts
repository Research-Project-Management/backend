import { NotificationTypeString } from '../value-objects/notification-type.vo';

export interface NotificationProps {
  id: string;
  userId: string;
  key?: string | null;
  templateKey: string;
  type?: NotificationTypeString;
  projectId?: string | null;
  docId?: string | null;
  actorId?: string | null;
  messageOpts?: Record<string, any>;
  isRead?: boolean;
  expiresAt?: Date | null;
  createdAt?: Date;
  readAt?: Date | null;
}

export class NotificationEntity {
  readonly id: string;
  readonly userId: string;
  readonly key: string | null;
  readonly templateKey: string;
  readonly type: NotificationTypeString;
  readonly projectId: string | null;
  readonly docId: string | null;
  readonly actorId: string | null;
  readonly messageOpts: Record<string, any>;
  private _isRead: boolean;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
  private _readAt: Date | null;

  constructor(props: NotificationProps) {
    this.id = props.id;
    this.userId = props.userId;
    this.key = props.key ?? null;
    this.templateKey = props.templateKey;
    this.type = props.type ?? 'mention';
    this.projectId = props.projectId ?? null;
    this.docId = props.docId ?? null;
    this.actorId = props.actorId ?? null;
    this.messageOpts = props.messageOpts ?? {};
    this._isRead = props.isRead ?? false;
    this.expiresAt = props.expiresAt ?? null;
    this.createdAt = props.createdAt ?? new Date();
    this._readAt = props.readAt ?? (this._isRead ? new Date() : null);
  }

  get isRead(): boolean {
    return this._isRead;
  }

  get readAt(): Date | null {
    return this._readAt;
  }

  markAsRead(): void {
    if (!this._isRead) {
      this._isRead = true;
      this._readAt = new Date();
    }
  }

  markAsUnread(): void {
    this._isRead = false;
    this._readAt = null;
  }

  isExpired(now: Date = new Date()): boolean {
    if (!this.expiresAt) return false;
    return this.expiresAt.getTime() <= now.getTime();
  }

  toPlain(): Record<string, any> {
    return {
      id: this.id,
      userId: this.userId,
      key: this.key,
      templateKey: this.templateKey,
      type: this.type,
      projectId: this.projectId,
      docId: this.docId,
      actorId: this.actorId,
      messageOpts: this.messageOpts,
      isRead: this._isRead,
      expiresAt: this.expiresAt?.toISOString() ?? null,
      createdAt: this.createdAt.toISOString(),
      readAt: this._readAt?.toISOString() ?? null,
    };
  }
}
