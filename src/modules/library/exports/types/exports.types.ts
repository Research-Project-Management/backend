import { ExportFormatType } from '../dto/exports.dto';
import { BurnableAnnotation } from '../services/pdf-baker.service';

export { ExportFormatType, BurnableAnnotation };

export interface ExportResult {
  format: ExportFormatType;
  filename: string;
  mimeType: string;
  content: string;
  itemCount: number;
  /** True when the library has more items than the export cap (1000). */
  truncated: boolean;
}

export interface CsvExportItem {
  id: string;
  title?: string | null;
  authors?: string[];
  year?: number | null;
  publicationTitle?: string | null;
  doi?: string | null;
  itemType?: string | null;
}
