import { Injectable, Logger } from '@nestjs/common';

export interface RagIndexPaperInput {
  id: string;
  title: string;
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

  /**
   * Transforms an academic paper to markdown and uploads it to FLux-AI for Qdrant vector indexing.
   */
  async indexPaper(item: RagIndexPaperInput): Promise<RagIndexResult> {
    const fluxUrl = process.env.FLUX_AI_URL || 'http://localhost:8000';

    const authorsStr =
      item.contributors?.map((c) => c.fullName).join(', ') || '';
    const docContent = `# ${item.title}\nAuthors: ${authorsStr}\nYear: ${item.year || 'N/A'}\nDOI: ${item.doi || 'N/A'}\nPublication: ${item.publicationTitle || 'N/A'}\n\n## Abstract\n${item.abstract || 'No abstract provided.'}\n\n## Metadata\nType: ${item.itemType || 'paper'}\n`;

    const formData = new FormData();
    const blob = new Blob([docContent], { type: 'text/markdown' });
    formData.append('file', blob, `${item.id}.md`);
    formData.append('title', item.title);
    formData.append('tags', 'academic-paper,library');

    const res = await fetch(`${fluxUrl}/documents/upload`, {
      method: 'POST',
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
