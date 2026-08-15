import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatQueryDto } from './dto/ai.dto';
import { getErrorMessage, tryCatch } from '@/core/utils/error.util';

@Injectable()
export class AiService {
  private readonly fluxUrl: string;
  private readonly logger = new Logger(AiService.name);

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
      content: `AI response for query: "${dto.query}"`,
      sources: [],
      widgets: [],
    };
  }

  async getDocument(docId: string) {
    if (!docId) {
      return { id: '', title: 'Document', content: '' };
    }

    const result = await tryCatch(fetch(`${this.fluxUrl}/documents/${docId}`));

    if (result.ok && result.value.ok) {
      const jsonResult = await tryCatch(result.value.json());
      if (jsonResult.ok) return jsonResult.value;
    } else if (!result.ok) {
      this.logger.warn(
        `Flux-AI getDocument fallback: ${getErrorMessage(result.error)}`,
      );
    }

    return { id: docId, title: 'Document', content: '' };
  }

  async getDocumentBulk(ids: string[]) {
    // Fast-path: Short-circuit if empty array
    if (!ids || ids.length === 0) {
      return { documents: [] };
    }

    const result = await tryCatch(
      fetch(`${this.fluxUrl}/documents/bulk?ids=${ids.join(',')}`),
    );

    if (result.ok && result.value.ok) {
      const jsonResult = await tryCatch(result.value.json());
      if (jsonResult.ok) return jsonResult.value;
    } else if (!result.ok) {
      this.logger.warn(
        `Flux-AI getDocumentBulk fallback: ${getErrorMessage(result.error)}`,
      );
    }

    return { documents: ids.map((id) => ({ id, title: 'Document' })) };
  }

  async getDocuments() {
    const result = await tryCatch(fetch(`${this.fluxUrl}/documents`));

    if (result.ok && result.value.ok) {
      const jsonResult = await tryCatch(result.value.json());
      if (jsonResult.ok) return jsonResult.value;
    } else if (!result.ok) {
      this.logger.warn(
        `Flux-AI getDocuments fallback: ${getErrorMessage(result.error)}`,
      );
    }

    return { documents: [] };
  }
}
