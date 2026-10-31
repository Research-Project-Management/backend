export const CITATION_FACADE = 'CITATION_FACADE';

export interface ICitationFacade<
  TStyleId = string,
  TFormattedResult = unknown,
  TExportDto = Record<string, unknown>,
  TExportResult = unknown,
> {
  formatCitation(
    userId: string,
    itemId: string,
    styleId?: TStyleId,
    index?: number,
    projectId?: string,
  ): Promise<TFormattedResult>;
  exportByCitationKeys(
    userId: string,
    citeKeys: string[],
    projectId?: string,
  ): Promise<{
    content: string;
    count: number;
    foundKeys: string[];
    missingKeys: string[];
  }>;
  exportLibrary(
    userId: string,
    options?: TExportDto,
  ): Promise<TExportResult>;
}
