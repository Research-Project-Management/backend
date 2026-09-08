import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

export interface RagIndexPaperInput {
  id: string;
  title: string;
  workspaceId?: string;
  year?: number | null;
  doi?: string | null;
  publicationTitle?: string | null;
  abstract?: string | null;
  itemType?: string | null;
  contributors?: Array<{ fullName: string }>;
}

export interface RagIndexResult {
  docId: string;
}

@Injectable()
export class RagIndexerProvider {
  private readonly logger = new Logger(RagIndexerProvider.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * Transforms an academic paper to markdown and uploads it to FLux-AI for Qdrant vector indexing.
   */
  async indexPaper(item: RagIndexPaperInput): Promise<RagIndexResult> {
    const fluxUrl =
      this.configService.get<string>('FLUX_AI_URL') ||
      process.env.FLUX_AI_URL ||
      'http://localhost:8000';
    const internalKey =
      this.configService.get<string>('INTERNAL_API_KEY') ||
      process.env.INTERNAL_API_KEY;
    const jwtSecret =
      this.configService.get<string>('JWT_SECRET') || process.env.JWT_SECRET;

    const authorsStr =
      item.contributors?.map((c) => c.fullName).join(', ') || '';
    const docContent = `# ${item.title}\nAuthors: ${authorsStr}\nYear: ${item.year || 'N/A'}\nDOI: ${item.doi || 'N/A'}\nPublication: ${item.publicationTitle || 'N/A'}\n\n## Abstract\n${item.abstract || 'No abstract provided.'}\n\n## Metadata\nType: ${item.itemType || 'paper'}\n`;

    const formData = new FormData();
    const blob = new Blob([docContent], { type: 'text/markdown' });
    formData.append('file', blob, `${item.id}.md`);
    formData.append('title', item.title);
    formData.append('tags', 'academic-paper,library');
    if (item.workspaceId) {
      formData.append('workspace_id', item.workspaceId);
    }

    const headers: Record<string, string> = {};
    if (internalKey) {
      headers['X-Internal-Key'] = internalKey;
    }
    if (jwtSecret) {
      const token = await this.jwtService.signAsync(
        {
          sub: 'system',
          workspace_id: item.workspaceId,
          scope: 'ai-delegated-action',
        },
        { secret: jwtSecret, expiresIn: '5m' },
      );
      headers['Authorization'] = `Bearer ${token}`;
    }

    const res = await fetch(`${fluxUrl}/documents/upload`, {
      method: 'POST',
      headers,
      body: formData,
    });

    if (!res.ok) {
      throw new Error(`FLux-AI upload failed with status ${res.status}`);
    }

    const json = (await res.json()) as { id: string };
    this.logger.log(
      `Paper ${item.id} successfully indexed into Qdrant (docId: ${json.id})`,
    );

    return { docId: json.id };
  }
}
