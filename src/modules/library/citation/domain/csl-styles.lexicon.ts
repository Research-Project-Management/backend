export interface CslStyleMetadata {
  id: string;
  name: string;
  title: string;
  titleShort?: string;
  category: 'author-date' | 'numeric' | 'label' | 'note' | 'raw';
  fields?: string[];
  updated?: string;
  isCustom?: boolean;
}

export function parseCslCategory(val?: unknown): CslStyleMetadata['category'] {
  if (
    val === 'author-date' ||
    val === 'numeric' ||
    val === 'label' ||
    val === 'note' ||
    val === 'raw'
  ) {
    return val;
  }
  return 'author-date';
}

/**
 * Authoritative built-in offline catalog of the most widely used international
 * academic journals and publisher styles (Nature, Science, Cell, IEEE, ACM, Lancet, etc.).
 * Ensures instant search and rendering even when the network is restricted.
 */
export const POPULAR_STYLES: ReadonlyArray<CslStyleMetadata> = [
  { id: 'apa-7th', name: 'apa', title: 'American Psychological Association 7th edition (APA)', titleShort: 'APA', category: 'author-date' },
  { id: 'ieee', name: 'ieee', title: 'IEEE (Institute of Electrical and Electronics Engineers)', titleShort: 'IEEE', category: 'numeric' },
  { id: 'mla-9th', name: 'modern-language-association', title: 'Modern Language Association 9th edition (MLA)', titleShort: 'MLA', category: 'author-date' },
  { id: 'chicago-author-date', name: 'chicago-author-date', title: 'Chicago Manual of Style 17th edition (Author-Date)', titleShort: 'Chicago', category: 'author-date' },
  { id: 'harvard', name: 'harvard-cite-them-right', title: 'Harvard (Cite Them Right 12th edition)', titleShort: 'Harvard', category: 'author-date' },
  { id: 'vancouver', name: 'vancouver', title: 'Vancouver (ICMJE Recommended)', titleShort: 'Vancouver', category: 'numeric' },
  { id: 'nature', name: 'nature', title: 'Nature', titleShort: 'Nature', category: 'numeric' },
  { id: 'tcvn', name: 'tcvn', title: 'Tiêu chuẩn Việt Nam (TCVN 7539 / Bộ GD&ĐT)', titleShort: 'TCVN', category: 'author-date' },
  { id: 'tcvn-numeric', name: 'tcvn-numeric', title: 'Tiêu chuẩn Việt Nam (TCVN 7539 - Đánh số)', titleShort: 'TCVN (Số)', category: 'numeric' },
  { id: 'science', name: 'science', title: 'Science (AAAS)', titleShort: 'Science', category: 'numeric' },
  { id: 'cell', name: 'cell', title: 'Cell Press', titleShort: 'Cell', category: 'author-date' },
  { id: 'the-lancet', name: 'the-lancet', title: 'The Lancet', titleShort: 'Lancet', category: 'numeric' },
  { id: 'plos-one', name: 'plos-one', title: 'PLOS ONE', titleShort: 'PLOS ONE', category: 'numeric' },
  { id: 'pnas', name: 'pnas', title: 'Proceedings of the National Academy of Sciences (PNAS)', titleShort: 'PNAS', category: 'numeric' },
  { id: 'association-for-computing-machinery', name: 'association-for-computing-machinery', title: 'ACM (Association for Computing Machinery)', titleShort: 'ACM', category: 'numeric' },
  { id: 'acm-siggraph', name: 'acm-siggraph', title: 'ACM SIGGRAPH / Computer Graphics', titleShort: 'SIGGRAPH', category: 'author-date' },
  { id: 'springer-lecture-notes-in-computer-science', name: 'springer-lecture-notes-in-computer-science', title: 'Springer LNCS (Lecture Notes in Computer Science)', titleShort: 'LNCS', category: 'numeric' },
  { id: 'american-chemical-society', name: 'american-chemical-society', title: 'ACS (American Chemical Society)', titleShort: 'ACS', category: 'numeric' },
  { id: 'american-medical-association', name: 'american-medical-association', title: 'AMA (American Medical Association 11th edition)', titleShort: 'AMA', category: 'numeric' },
  { id: 'american-institute-of-physics', name: 'american-institute-of-physics', title: 'American Institute of Physics (AIP)', titleShort: 'AIP', category: 'numeric' },
  { id: 'biomed-central', name: 'biomed-central', title: 'BioMed Central (BMC)', titleShort: 'BMC', category: 'numeric' },
  { id: 'british-medical-journal', name: 'british-medical-journal', title: 'British Medical Journal (BMJ)', titleShort: 'BMJ', category: 'numeric' },
  { id: 'cambridge-university-press-author-date', name: 'cambridge-university-press-author-date', title: 'Cambridge University Press (Author-Date)', titleShort: 'Cambridge', category: 'author-date' },
  { id: 'oxford-university-press-note', name: 'oxford-university-press-note', title: 'Oxford University Press (Note)', titleShort: 'Oxford', category: 'note' },
  { id: 'elsevier-harvard', name: 'elsevier-harvard', title: 'Elsevier - Harvard (with titles)', titleShort: 'Elsevier', category: 'author-date' },
  { id: 'elsevier-vancouver', name: 'elsevier-vancouver', title: 'Elsevier - Vancouver', titleShort: 'Elsevier', category: 'numeric' },
  { id: 'elsevier-with-titles', name: 'elsevier-with-titles', title: 'Elsevier Numeric (with titles)', titleShort: 'Elsevier', category: 'numeric' },
  { id: 'springer-basic-author-date', name: 'springer-basic-author-date', title: 'Springer Basic (Author-Date)', titleShort: 'Springer', category: 'author-date' },
  { id: 'springer-vancouver', name: 'springer-vancouver', title: 'Springer - Vancouver', titleShort: 'Springer', category: 'numeric' },
  { id: 'royal-society-of-chemistry', name: 'royal-society-of-chemistry', title: 'Royal Society of Chemistry (RSC)', titleShort: 'RSC', category: 'numeric' },
  { id: 'frontiers', name: 'frontiers', title: 'Frontiers Journals', titleShort: 'Frontiers', category: 'author-date' },
  { id: 'multidisciplinary-digital-publishing-institute', name: 'multidisciplinary-digital-publishing-institute', title: 'MDPI Journals', titleShort: 'MDPI', category: 'numeric' },
  { id: 'bibtex', name: 'bibtex', title: 'BibTeX (LaTeX Standard)', titleShort: 'BibTeX', category: 'raw' },
  { id: 'ris', name: 'ris', title: 'Research Information Systems (RIS)', titleShort: 'RIS', category: 'raw' },
];

export const REMOTE_STYLE_SLUG_ALIASES: Readonly<Record<string, string>> = {
  'apa-7th': 'apa',
  mla: 'modern-language-association',
  'mla-9th': 'modern-language-association',
  chicago: 'chicago-author-date',
  harvard: 'harvard-cite-them-right',
  harvard1: 'harvard-cite-them-right',
  mdpi: 'multidisciplinary-digital-publishing-institute',
  bmj: 'british-medical-journal',
};
