export interface PublicPresence {
  userId: string;
  name: string;
  color?: string;
  avatar?: string;
  socketId: string;
}

export class PresenceMapper {
  private static readonly DEFAULT_COLOR = '#3b82f6';
  private static readonly COLOR_HEX_REGEX =
    /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

  public static sanitizeColor(color?: string | null): string {
    if (!color || typeof color !== 'string') {
      return PresenceMapper.DEFAULT_COLOR;
    }
    const trimmed = color.trim();
    return PresenceMapper.COLOR_HEX_REGEX.test(trimmed)
      ? trimmed
      : PresenceMapper.DEFAULT_COLOR;
  }

  public static sanitizeAvatar(avatar?: string | null): string | undefined {
    if (!avatar || typeof avatar !== 'string') {
      return undefined;
    }
    const trimmed = avatar.trim();
    if (trimmed.length === 0 || trimmed.length > 1000) {
      return undefined;
    }
    if (
      trimmed.startsWith('https://') ||
      trimmed.startsWith('http://') ||
      trimmed.startsWith('data:image/')
    ) {
      return trimmed;
    }
    return undefined;
  }

  public static toPublicPresence(
    data: {
      userId?: string;
      name?: string;
      color?: string | null;
      avatar?: string | null;
    },
    socketId: string,
  ): PublicPresence {
    return {
      userId: data.userId || '',
      name: data.name?.trim() || 'Collaborator',
      color: PresenceMapper.sanitizeColor(data.color),
      avatar: PresenceMapper.sanitizeAvatar(data.avatar),
      socketId,
    };
  }

  public static toLeavePresence(
    userId: string,
    socketId: string,
  ): { userId: string; socketId: string } {
    return {
      userId,
      socketId,
    };
  }
}
