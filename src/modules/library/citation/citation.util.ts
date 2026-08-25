export * from './utils/name-parser.util';

export function normalizeDoiForCitation(doi?: string | null): string {
  return (
    doi
      ?.trim()
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
      .replace(/^doi:\s*/i, '') ?? ''
  );
}

export function buildDoiUrl(doi?: string | null): string {
  const cleanDoi = normalizeDoiForCitation(doi);
  return cleanDoi ? `https://doi.org/${cleanDoi}` : '';
}
