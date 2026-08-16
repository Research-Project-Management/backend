import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatQueryDto } from './dto/chat.dto';
import { getErrorMessage, tryCatch } from '@/core/utils/error.util';

@Injectable()
export class ChatService {
  private readonly fluxUrl: string;
  private readonly logger = new Logger(ChatService.name);

  constructor(private readonly configService: ConfigService) {
    this.fluxUrl =
      this.configService.get<string>('FLUX_AI_URL') || 'http://localhost:8000';
  }

  async health() {
    const result = await tryCatch(
      fetch(`${this.fluxUrl}/health`, { method: 'GET' }),
    );

    if (result.ok && result.value.ok) {
      const jsonResult = await tryCatch(result.value.json());
      if (jsonResult.ok) return jsonResult.value;
    }

    return { status: 'ok', service: 'flux-ai-proxy' };
  }

  async chatSync(userId: string, dto: ChatQueryDto) {
    if (!dto.query || !dto.query.trim()) {
      return {
        role: 'assistant',
        content: '',
        sources: [],
        widgets: [],
      };
    }

    const result = await tryCatch(
      fetch(`${this.fluxUrl}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: userId,
          query: dto.query,
          messages: dto.messages || [],
          document_ids: dto.document_ids || dto.selected_files || [],
        }),
      }),
    );

    if (result.ok) {
      if (result.value.ok) {
        const jsonResult = await tryCatch(result.value.json());
        if (jsonResult.ok) return jsonResult.value;
      }
    } else {
      this.logger.warn(
        `Flux-AI chat connection fallback: ${getErrorMessage(result.error)}`,
      );
    }

    return {
      role: 'assistant',
      content:
        'AI Assistant service is currently offline. Please ensure the Flux-AI backend service is running on ' +
        this.fluxUrl,
      sources: [],
      widgets: [],
    };
  }

  async getDocuments() {
    const result = await tryCatch(
      fetch(`${this.fluxUrl}/documents`, { method: 'GET' }),
    );

    if (result.ok && result.value.ok) {
      const jsonResult = await tryCatch(result.value.json());
      if (jsonResult.ok) return jsonResult.value;
    }

    return [];
  }

  async getDocumentBulk(ids: string[]) {
    const result = await tryCatch(
      fetch(`${this.fluxUrl}/documents/bulk?ids=${ids.join(',')}`, {
        method: 'GET',
      }),
    );

    if (result.ok && result.value.ok) {
      const jsonResult = await tryCatch(result.value.json());
      if (jsonResult.ok) return jsonResult.value;
    }

    return [];
  }

  async getDocument(docId: string) {
    const result = await tryCatch(
      fetch(`${this.fluxUrl}/documents/${docId}`, { method: 'GET' }),
    );

    if (result.ok && result.value.ok) {
      const jsonResult = await tryCatch(result.value.json());
      if (jsonResult.ok) return jsonResult.value;
    }

    return null;
  }
}
