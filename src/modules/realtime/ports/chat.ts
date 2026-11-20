export const CHAT_REALTIME_PORT = Symbol('CHAT_REALTIME_PORT');

export interface ChatSendMessageInput {
  content: string;
  type?: 'text' | 'image' | 'file' | 'system';
  attachments?: unknown[];
  replyToId?: string;
}

export interface ChatRealtimePort {
  verifyConversationMember(
    conversationId: string,
    userId: string,
  ): Promise<unknown>;
  getConversationMemberIds(conversationId: string): Promise<string[]>;
  sendMessage(
    conversationId: string,
    senderId: string,
    dto: ChatSendMessageInput,
  ): Promise<unknown>;
  markAsRead(
    conversationId: string,
    userId: string,
  ): Promise<{ success: boolean; lastReadAt: string }>;
  addReaction(
    messageId: string,
    userId: string,
    emoji: string,
  ): Promise<{ conversationId: string }>;
  removeReaction(
    messageId: string,
    userId: string,
    emoji: string,
  ): Promise<{ success: boolean; conversationId: string }>;
}
