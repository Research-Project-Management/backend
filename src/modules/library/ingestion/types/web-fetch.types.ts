export const WEB_FETCH_PORT = Symbol('WEB_FETCH_PORT');

export interface WebFetchOptions {
  scopeId?: string;
  userId?: string;
  preferredFilename?: string;
  timeoutMs?: number;
  skipStealth?: boolean;
}

export interface MirrorBibliographicMetadata {
  title?: string;
  abstract?: string;
  authors?: string[];
  year?: number;
  doi?: string;
  pmid?: string;
  pmcid?: string;
  journal?: string;
  isOpenAccess?: boolean;
  pdfUrl?: string;
  sourceMirror:
    | 'EuropePMC'
    | 'arXiv'
    | 'PubMedCentral'
    | 'OpenMirror'
    | 'CrossRef'
    | 'OpenAlex';
}

export interface WebFetchResponse {
  url: string;
  finalUrl: string;
  status: number;
  isBlocked: boolean;
  wafKind?: string;
  bodyText?: string;
  bodyBuffer?: Buffer;
  isPdf: boolean;
  contentType?: string;
  ladderStepReached: 0 | 1 | 2 | 3 | 4;
  promptUploadPdf?: boolean;
  derivedIdentifier?: {
    doi?: string;
    arxivId?: string;
    pmid?: string;
    pmcid?: string;
  };
  mirrorMetadata?: MirrorBibliographicMetadata;
  headers?: Record<string, string>;
  warnings?: string[];
}

export interface IWebFetchPort {
  fetch(url: string, options?: WebFetchOptions): Promise<WebFetchResponse>;
}
