import { PdfAnnotation } from '../../annotations/types/annotations.types';
import { toItemView } from '../../items/items.mapper';

export interface ReportRow {
  label: string;
  value: string;
  present: boolean;
}

export interface ReportNote {
  title?: string;
  content: string;
  createdAt?: string;
}

export interface ReportAttachment {
  id: string;
  filename: string;
  url: string;
  mimeType: string;
  size: number;
  attachmentType: string;
  uploadedAt: string;
}

export interface ItemReport {
  item: ReturnType<typeof toItemView>;
  title: string;
  metadataRows: ReportRow[];
  metadataCompleteness: {
    present: string[];
    missing: string[];
  };
  abstractNote: string;
  tags: string[];
  notes: ReportNote[];
  attachments: ReportAttachment[];
  annotations: PdfAnnotation[];
  collections: { id: string; name: string }[];
  relatedCount: number;
  generatedAt: string;
}

export interface CollectionReport {
  collection: { id: string; name: string; description?: string };
  totalItems: number;
  items: ItemReport[];
  generatedAt: string;
}

// Backward-compatible aliases
export type LibraryReportRow = ReportRow;
export type LibraryReportNote = ReportNote;
export type LibraryReportAttachment = ReportAttachment;
export type LibraryItemReport = ItemReport;
export type LibraryCollectionReport = CollectionReport;
