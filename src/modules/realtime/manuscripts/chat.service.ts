import { Injectable } from '@nestjs/common';
import { ChatMessage } from './types/presence.type';
import { ProjectChatSendDto } from './dto/events.dto';
import * as crypto from 'crypto';

@Injectable()
export class ChatService {
  private readonly projectChatStore = new Map<string, ChatMessage[]>();
  private static readonly MAX_CHAT_HISTORY = 200;
  private static readonly MAX_PROJECT_CHATS = 500;

  public saveMessage(
    dto: ProjectChatSendDto,
    user: { id: string; name: string; color?: string; avatar?: string },
  ): ChatMessage {
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      projectId: dto.projectId,
      userId: user.id,
      userName: user.name,
      userColor: user.color,
      userAvatar: user.avatar,
      text: dto.text,
      replyToId: dto.replyToId,
      createdAt: new Date().toISOString(),
    };

    let history = this.projectChatStore.get(dto.projectId);
    if (history) {
      // Refresh LRU order
      this.projectChatStore.delete(dto.projectId);
    } else {
      history = [];
      if (this.projectChatStore.size >= ChatService.MAX_PROJECT_CHATS) {
        const oldestKey = this.projectChatStore.keys().next().value;
        if (oldestKey !== undefined) {
          this.projectChatStore.delete(oldestKey);
        }
      }
    }
    this.projectChatStore.set(dto.projectId, history);
    history.push(message);

    if (history.length > ChatService.MAX_CHAT_HISTORY) {
      history.splice(0, history.length - ChatService.MAX_CHAT_HISTORY);
    }

    return message;
  }

  public getHistory(projectId: string): ChatMessage[] {
    return this.projectChatStore.get(projectId) ?? [];
  }
}
