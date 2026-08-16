import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ThreadRepository } from './thread.repository';
import {
  CreateThreadDto,
  AppendMessagesDto,
  RenameThreadDto,
} from './dto/thread.dto';
import { MessageRole } from '@prisma/client';

@Injectable()
export class ThreadService {
  constructor(private readonly threadRepo: ThreadRepository) {}

  async getChats(workspaceId: string, userId: string) {
    if (!workspaceId) {
      throw new BadRequestException('workspaceId is required');
    }
    return this.threadRepo.findUserChats(workspaceId, userId);
  }

  async getPageChat(pageId: string, workspaceId: string, userId: string) {
    if (!pageId || !workspaceId) {
      throw new BadRequestException('pageId and workspaceId are required');
    }
    const chat = await this.threadRepo.findPageChat(
      pageId,
      workspaceId,
      userId,
    );
    return { chat };
  }

  async getChat(chatId: string) {
    const chat = await this.threadRepo.findChatById(chatId);
    if (!chat) {
      throw new NotFoundException('Chat not found');
    }
    return { chat };
  }

  async createChat(userId: string, dto: CreateThreadDto) {
    const workspaceSlug = dto.workspaceSlug || dto.workspaceId;
    if (!workspaceSlug) {
      throw new BadRequestException('workspaceSlug or workspaceId is required');
    }

    return this.threadRepo.createChat({
      userId,
      workspaceSlug,
      projectId: dto.projectId,
      pageId: dto.pageId,
      title: dto.title,
    });
  }

  async appendMessages(chatId: string, dto: AppendMessagesDto) {
    const chat = await this.threadRepo.findChatById(chatId);
    if (!chat) {
      throw new NotFoundException('Chat not found');
    }

    const formattedMessages = dto.messages.map((m: any) => ({
      role: (m.role as MessageRole) || MessageRole.user,
      content: m.content || '',
      sources: m.sources,
      widgets: m.widgets,
      selectionContext: m.selectionContext,
    }));

    return this.threadRepo.createMessages(chatId, formattedMessages);
  }

  async renameChat(chatId: string, dto: RenameThreadDto) {
    const chat = await this.threadRepo.findChatById(chatId);
    if (!chat) {
      throw new NotFoundException('Chat not found');
    }

    return this.threadRepo.updateChatTitle(chatId, dto.title);
  }

  async deleteChat(chatId: string) {
    await this.threadRepo.deleteChat(chatId);
    return { success: true };
  }
}
