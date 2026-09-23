export type NotificationTypeString =
  | 'mention'
  | 'comment_reply'
  | 'thread_resolved'
  | 'project_invite'
  | 'review_request'
  | 'system';

export class NotificationType {
  static readonly MENTION: NotificationTypeString = 'mention';
  static readonly COMMENT_REPLY: NotificationTypeString = 'comment_reply';
  static readonly THREAD_RESOLVED: NotificationTypeString = 'thread_resolved';
  static readonly PROJECT_INVITE: NotificationTypeString = 'project_invite';
  static readonly REVIEW_REQUEST: NotificationTypeString = 'review_request';
  static readonly SYSTEM: NotificationTypeString = 'system';

  private static readonly VALID_TYPES = new Set<string>([
    'mention',
    'comment_reply',
    'thread_resolved',
    'project_invite',
    'review_request',
    'system',
  ]);

  static isValid(type: string): type is NotificationTypeString {
    return this.VALID_TYPES.has(type);
  }

  static fromString(type: string): NotificationTypeString {
    if (!this.isValid(type)) {
      throw new Error(`Unsupported notification type: ${type}`);
    }
    return type;
  }
}
