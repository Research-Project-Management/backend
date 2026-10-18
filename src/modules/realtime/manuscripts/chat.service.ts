import { Injectable } from '@nestjs/common';
import { ChatMessage } from './types/presence.type';
import { ProjectChatSendDto } from './dto/events.dto';
import * as crypto from 'crypto';

@Injectable()
export class ChatService {
  private readonly projectChatStore = new Map<string, ChatMessage[]>();
  private static readonly MAX_CHAT_HISTORY = 200;

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
    if (!history) {
      history = [];
      this.projectChatStore.set(dto.projectId, history);
    }
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
