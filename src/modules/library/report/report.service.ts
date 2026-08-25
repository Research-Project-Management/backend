import { Injectable, NotFoundException } from '@nestjs/common';
import { CatalogRepository } from '../catalog/catalog.repository';
import { CatalogExtraStore } from '../catalog/catalog-extra.store';
import { LibraryItemRecord } from '../catalog/items/item.types';
import { toLibraryItemView } from '../catalog/items/item.mapper';
import { PdfAnnotation } from '../attachments/annotations/annotations.types';

export interface LibraryReportRow {
  label: string;
  value: string;
  present: boolean;
}

export interface LibraryReportNote {
  title?: string;
  content: string;
  createdAt?: string;
}

export interface LibraryReportAttachment {
  id: string;
  filename: string;
  url: string;
  mimeType: string;
  size: number;
  attachmentType: string;
  uploadedAt: string;
}

export interface LibraryItemReport {
  item: ReturnType<typeof toLibraryItemView>;
  title: string;
  metadataRows: LibraryReportRow[];
  metadataCompleteness: {
    present: string[];
    missing: string[];
  };
  abstractNote: string;
  tags: string[];
  notes: LibraryReportNote[];
  attachments: LibraryReportAttachment[];
  annotations: PdfAnnotation[];
  collections: { id: string; name: string }[];
  relatedCount: number;
  generatedAt: string;
}

export interface LibraryCollectionReport {
  collection: { id: string; name: string; description?: string };
  totalItems: number;
  items: LibraryItemReport[];
  generatedAt: string;
}

@Injectable()
export class LibraryReportService {
  constructor(
    private readonly catalogRepo: CatalogRepository,
    private readonly extraStore: CatalogExtraStore,
  ) {}

  async getItemReport(
    workspaceId: string,
    itemId: string,
  ): Promise<LibraryItemReport> {
    const targetWsId = await this.catalogRepo.resolveWorkspaceId(workspaceId);
    const item = await this.catalogRepo.findItemByIdInWorkspace(
      targetWsId,
      itemId,
    );

    if (!item || item.deletedAt) {
      throw new NotFoundException('Catalog item not found in this workspace');
    }

    const [annotations, relations] = await Promise.all([
      this.extraStore.getAnnotations(item.id),
      this.extraStore.getRelations(item.id),
    ]);

    const view = toLibraryItemView(item);
    const metadataRows = this.buildMetadataRows(item);

    return {
      item: view,
      title: item.title,
      metadataRows,
      metadataCompleteness: {
        present: metadataRows.filter((row) => row.present).map((row) => row.label),
        missing: metadataRows
          .filter((row) => !row.present)
          .map((row) => row.label),
      },
      abstractNote: item.abstract?.trim() ?? '',
      tags: item.labels ?? [],
      notes: this.normalizeNotes(item.notes),
      attachments: (item.attachments ?? []).map((attachment) => ({
        id: attachment.id,
        filename: attachment.filename,
        url: attachment.url,
        mimeType: attachment.mimeType,
        size: attachment.size,
        attachmentType: attachment.attachmentType,
        uploadedAt: attachment.uploadedAt.toISOString(),
      })),
      annotations,
      collections: item.collection
        ? [{ id: item.collection.id, name: item.collection.name }]
        : [],
      relatedCount: relations.length,
      generatedAt: new Date().toISOString(),
    };
  }

  async getCollectionReport(
    workspaceId: string,
    collectionId: string,
  ): Promise<LibraryCollectionReport> {
    const targetWsId = await this.catalogRepo.resolveWorkspaceId(workspaceId);
    const collection = await this.catalogRepo.findCollectionById(collectionId);
    if (!collection || collection.workspaceId !== targetWsId) {
      throw new NotFoundException('Collection not found in this workspace');
    }

    const items = await this.catalogRepo.findItems({
      workspaceId: targetWsId,
      collectionId: collection.id,
      deletedAt: null,
    });

    const itemReports: LibraryItemReport[] = await Promise.all(
      items.map(async (item) => {
        const [annotations, relations] = await Promise.all([
          this.extraStore.getAnnotations(item.id),
          this.extraStore.getRelations(item.id),
        ]);
        const view = toLibraryItemView(item);
        const metadataRows = this.buildMetadataRows(item);

        return {
          item: view,
          title: item.title,
          metadataRows,
          metadataCompleteness: {
            present: metadataRows
              .filter((row) => row.present)
              .map((row) => row.label),
            missing: metadataRows
              .filter((row) => !row.present)
              .map((row) => row.label),
          },
          abstractNote: item.abstract?.trim() ?? '',
          tags: item.labels ?? [],
          notes: this.normalizeNotes(item.notes),
          attachments: (item.attachments ?? []).map((attachment) => ({
            id: attachment.id,
            filename: attachment.filename,
            url: attachment.url,
            mimeType: attachment.mimeType,
            size: attachment.size,
            attachmentType: attachment.attachmentType,
            uploadedAt: attachment.uploadedAt.toISOString(),
          })),
          annotations,
          collections: [{ id: collection.id, name: collection.name }],
          relatedCount: relations.length,
          generatedAt: new Date().toISOString(),
        };
      }),
    );

    return {
      collection: {
        id: collection.id,
        name: collection.name,
        description: collection.description || undefined,
      },
      totalItems: itemReports.length,
      items: itemReports,
      generatedAt: new Date().toISOString(),
    };
  }

  renderCollectionHtml(report: LibraryCollectionReport): string {
    const toc = report.items
      .map(
        (item, index) =>
          `<li><a href="#item-${item.item.id}">${index + 1}. ${this.escapeHtml(
            item.title,
          )}</a> <small>(${item.item.itemType || 'item'}, ${item.item.year || 'n.d.'})</small></li>`,
      )
      .join('\n');

    const sections = report.items
      .map((item, index) => {
        const rows = item.metadataRows
          .filter((row) => row.present)
          .map(
            (row) =>
              `<tr><th>${this.escapeHtml(row.label)}</th><td>${this.linkifyValue(
                row.value,
              )}</td></tr>`,
          )
          .join('\n');

        const tags = item.tags.length
          ? `<div class="section-block"><strong>Tags:</strong> ${item.tags
              .map((tag) => `<span class="tag">${this.escapeHtml(tag)}</span>`)
              .join(' ')}</div>`
          : '';

        const notes = item.notes.length
          ? `<div class="section-block"><h4>Notes</h4>${item.notes
              .map(
                (n) =>
                  `<article class="note"><strong>${this.escapeHtml(
                    n.title || 'Note',
                  )}:</strong> ${this.escapeHtml(n.content)}</article>`,
              )
              .join('\n')}</div>`
          : '';

        return `<section id="item-${item.item.id}" class="item-section">
          <h2>${index + 1}. ${this.escapeHtml(item.title)}</h2>
          <table><tbody>${rows}</tbody></table>
          ${
            item.abstractNote
              ? `<div class="section-block"><h4>Abstract</h4><p>${this.escapeHtml(
                  item.abstractNote,
                )}</p></div>`
              : ''
          }
          ${tags}
          ${notes}
        </section>`;
      })
      .join('\n<hr class="divider"/>\n');

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${this.escapeHtml(report.collection.name)} - Collection Report</title>
  <style>
    body { font-family: Georgia, "Times New Roman", serif; line-height: 1.45; margin: 48px auto; max-width: 880px; color: #111; }
    h1 { font-size: 32px; margin: 0 0 8px; border-bottom: 2px solid #333; padding-bottom: 12px; }
    h2 { font-size: 22px; margin: 24px 0 10px; color: #1a1a1a; }
    h3 { font-size: 18px; margin: 18px 0 6px; }
    h4 { font-size: 15px; margin: 12px 0 4px; color: #444; }
    table { border-collapse: collapse; width: 100%; border: 1px solid #ccc; margin: 12px 0; }
    th { width: 180px; text-align: right; vertical-align: top; padding: 4px 10px; font-weight: 700; background: #fafafa; }
    td { padding: 4px 10px; vertical-align: top; }
    a { color: #b40000; text-decoration: none; }
    a:hover { text-decoration: underline; }
    small { color: #666; }
    .toc { background: #fdfdfd; border: 1px solid #e0e0e0; padding: 16px 24px; margin: 20px 0 32px; border-radius: 4px; }
    .toc ol { margin: 0; padding-left: 20px; }
    .toc li { margin-bottom: 6px; }
    .section-block { margin: 10px 0; }
    .tag { display: inline-block; background: #eee; padding: 2px 6px; border-radius: 3px; font-size: 12px; margin-right: 4px; }
    .note { background: #fbf8f0; border-left: 3px solid #e0c880; padding: 8px 12px; margin: 6px 0; font-size: 14px; }
    .divider { border: 0; border-top: 1px solid #ddd; margin: 36px 0; }
    .item-section { padding-top: 12px; }
  </style>
</head>
<body>
  <h1>${this.escapeHtml(report.collection.name)}</h1>
  <p><small>Total Items: ${report.totalItems} | Generated: ${report.generatedAt}</small></p>
  ${
    report.collection.description
      ? `<p>${this.escapeHtml(report.collection.description)}</p>`
      : ''
  }
  <div class="toc">
    <h3>Table of Contents</h3>
    <ol>${toc}</ol>
  </div>
  ${sections}
</body>
</html>`;
  }

  renderHtml(report: LibraryItemReport): string {
    const rows = report.metadataRows
      .filter((row) => row.present)
      .map(
        (row) => `<tr><th>${this.escapeHtml(row.label)}</th><td>${this.linkifyValue(
          row.value,
        )}</td></tr>`,
      )
      .join('\n');

    const tags = report.tags.length
      ? `<section><h2>Tags</h2><p>${report.tags
          .map((tag) => this.escapeHtml(tag))
          .join(', ')}</p></section>`
      : '';

    const notes = report.notes.length
      ? `<section><h2>Notes</h2>${report.notes
          .map(
            (note) =>
              `<article><h3>${this.escapeHtml(note.title || 'Note')}</h3><p>${this.escapeHtml(
                note.content,
              )}</p></article>`,
          )
          .join('\n')}</section>`
      : '';

    const attachments = report.attachments.length
      ? `<section><h2>Attachments</h2><ul>${report.attachments
          .map(
            (attachment) =>
              `<li>${this.escapeHtml(attachment.filename)} <small>${this.escapeHtml(
                attachment.mimeType,
              )}</small></li>`,
          )
          .join('\n')}</ul></section>`
      : '';

    const annotations = report.annotations.length
      ? `<section><h2>Annotations</h2><ul>${report.annotations
          .map((annotation) => {
            const text = annotation.comment || annotation.quote || 'Annotation';
            return `<li>p. ${this.escapeHtml(String(annotation.pageNumber))}: ${this.escapeHtml(
              text,
            )}</li>`;
          })
          .join('\n')}</ul></section>`
      : '';

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${this.escapeHtml(report.title)} - Library Report</title>
  <style>
    body { font-family: Georgia, "Times New Roman", serif; line-height: 1.45; margin: 48px auto; max-width: 880px; color: #111; }
    h1 { font-size: 30px; margin: 0 0 18px; }
    h2 { font-size: 20px; margin: 28px 0 10px; }
    h3 { font-size: 16px; margin: 14px 0 4px; }
    table { border-collapse: collapse; width: 100%; border: 1px solid #ccc; }
    th { width: 180px; text-align: right; vertical-align: top; padding: 4px 10px; font-weight: 700; }
    td { padding: 4px 10px; vertical-align: top; }
    a { color: #b40000; }
    small { color: #666; }
  </style>
</head>
<body>
  <h1>${this.escapeHtml(report.title)}</h1>
  <table><tbody>${rows}</tbody></table>
  ${
    report.abstractNote
      ? `<section><h2>Abstract</h2><p>${this.escapeHtml(report.abstractNote)}</p></section>`
      : ''
  }
  ${tags}
  ${notes}
  ${attachments}
  ${annotations}
</body>
</html>`;
  }

  private buildMetadataRows(item: LibraryItemRecord): LibraryReportRow[] {
    const authors = item.authors?.join('; ') ?? '';
    const editors = item.editors?.join('; ') ?? '';
    const extra = this.readReportExtra(item.extra);

    return [
      this.row('Item Type', item.itemType || item.type),
      this.row('Title', item.title),
      this.row('Author', authors),
      this.row('Editor', editors),
      this.row('Publication', item.publicationTitle || item.journal),
      this.row('Publisher', item.publisher),
      this.row('Place', item.place),
      this.row('Date', item.publicationDate || (item.year ? String(item.year) : '')),
      this.row('Volume', item.volume),
      this.row('Issue', item.issue),
      this.row('Section', item.section),
      this.row('Part Number', item.partNumber),
      this.row('Part Title', item.partTitle),
      this.row('Pages', item.pages),
      this.row('Series', item.series),
      this.row('Series Title', item.seriesTitle),
      this.row('Series Text', item.seriesText),
      this.row('Journal Abbr', item.journalAbbr),
      this.row('DOI', item.doi),
      this.row('Citation Key', item.citationKey),
      this.row('URL', item.url),
      this.row('Accessed', item.accessedAt?.toISOString()),
      this.row('PMID', item.pmid),
      this.row('PMCID', item.pmcid),
      this.row('ISSN', item.issn),
      this.row('ISBN', item.isbn),
      this.row('Archive', item.archive),
      this.row('Loc. in Archive', item.archiveLocation),
      this.row('Short Title', item.shortTitle),
      this.row('Language', item.language),
      this.row('Library Catalog', item.libraryCatalog),
      this.row('Call Number', item.callNumber),
      this.row('License', item.license || item.rights),
      this.row('Extra', extra),
      this.row('Date Added', item.createdAt.toISOString()),
      this.row('Modified', item.updatedAt.toISOString()),
    ];
  }

  private row(label: string, value?: string | null): LibraryReportRow {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return { label, value: normalized, present: normalized.length > 0 };
  }

  private normalizeNotes(notes: unknown): LibraryReportNote[] {
    if (!Array.isArray(notes)) return [];
    return notes
      .map((note) => {
        if (typeof note === 'string') {
          return { content: note.trim() };
        }
        if (!note || typeof note !== 'object') return null;

        const record = note as Record<string, unknown>;
        const content = String(
          record.content ?? record.text ?? record.note ?? '',
        ).trim();
        if (!content) return null;

        return {
          title:
            typeof record.title === 'string' && record.title.trim()
              ? record.title.trim()
              : undefined,
          content,
          createdAt:
            typeof record.createdAt === 'string' ? record.createdAt : undefined,
        };
      })
      .filter((note): note is LibraryReportNote => Boolean(note?.content));
  }

  private readReportExtra(extra: string | null): string {
    if (!extra?.trim()) return '';
    try {
      const parsed = JSON.parse(extra) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return extra.trim();
      }

      const { annotations: _annotations, relations: _relations, ...rest } = parsed;
      return Object.keys(rest).length > 0 ? JSON.stringify(rest) : '';
    } catch {
      return extra.trim();
    }
  }

  private linkifyValue(value: string): string {
    const escaped = this.escapeHtml(value);
    if (/^https?:\/\//i.test(value)) {
      return `<a href="${escaped}">${escaped}</a>`;
    }
    return escaped;
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
