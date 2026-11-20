import { Injectable } from '@nestjs/common';
import { ChatService } from '@/modules/chat/services/chat.service';
import type { ChatRealtimePort, ChatSendMessageInput } from '../ports/chat';

@Injectable()
export class ChatInProcessAdapter implements ChatRealtimePort {
  constructor(private readonly chatService: ChatService) {}

  public async verifyConversationMember(
    conversationId: string,
    userId: string,
  ): Promise<unknown> {
    return this.chatService.verifyConversationMember(conversationId, userId);
  }

  public async getConversationMemberIds(
    conversationId: string,
  ): Promise<string[]> {
    return this.chatService.getConversationMemberIds(conversationId);
  }

  public async sendMessage(
    conversationId: string,
    senderId: string,
    dto: ChatSendMessageInput,
  ): Promise<unknown> {
    return this.chatService.sendMessage(conversationId, senderId, {
      content: dto.content,
      type: dto.type,
      attachments: dto.attachments,
      replyToId: dto.replyToId,
    });
  }

  public async markAsRead(
    conversationId: string,
    userId: string,
  ): Promise<{ success: boolean; lastReadAt: string }> {
    return this.chatService.markAsRead(conversationId, userId);
  }

  public async addReaction(
    messageId: string,
    userId: string,
    emoji: string,
  ): Promise<{ conversationId: string }> {
    return this.chatService.addReaction(messageId, userId, emoji);
  }

  public async removeReaction(
    messageId: string,
    userId: string,
    emoji: string,
  ): Promise<{ success: boolean; conversationId: string }> {
    return this.chatService.removeReaction(messageId, userId, emoji);
  }
}
