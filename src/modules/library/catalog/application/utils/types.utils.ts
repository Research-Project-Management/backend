/**
 * Extended mapping for external providers (Crossref, arXiv, OpenAlex, Semantic Scholar, BibTeX)
 */
const ITEM_TYPE_ALIASES: Record<string, string> = {
  // arXiv / preprints
  preprint: 'preprint',
  'working-paper': 'preprint',
  'working paper': 'preprint',
  eprint: 'preprint',
  'posted-content': 'preprint',
  postedcontent: 'preprint',

  // Software / Code
  software: 'computerProgram',
  'software-code': 'computerProgram',
  code: 'computerProgram',
  program: 'computerProgram',
  computerprogram: 'computerProgram',
  algorithm: 'computerProgram',

  // Datasets
  dataset: 'dataset',
  data: 'dataset',
  database: 'dataset',
  'data-set': 'dataset',

  // Standards & Norms
  standard: 'standard',
  norm: 'standard',
  specification: 'standard',
  rfc: 'standard',

  // Journal & Articles
  journalarticle: 'journalArticle',
  'journal-article': 'journalArticle',
  article: 'journalArticle',
  paper: 'journalArticle',
  peer_review: 'journalArticle',

  // Conferences & Proceedings
  conferencepaper: 'conferencePaper',
  'proceedings-article': 'conferencePaper',
  proceedings: 'conferencePaper',
  conference: 'conferencePaper',
  inproceedings: 'conferencePaper',
  paper_conference: 'conferencePaper',

  // Books & Sections
  book: 'book',
  monograph: 'book',
  'edited-book': 'book',
  booksection: 'bookSection',
  'book-section': 'bookSection',
  'book-chapter': 'bookSection',
  incollection: 'bookSection',
  inbook: 'bookSection',
  chapter: 'bookSection',

  // Theses & Dissertations
  thesis: 'thesis',
  dissertation: 'thesis',
  phdthesis: 'thesis',
  mastersthesis: 'thesis',
  'doctoral-thesis': 'thesis',

  // Reports
  report: 'report',
  'tech-report': 'report',
  techreport: 'report',
  'research-report': 'report',
  whitepaper: 'report',

  // Patents
  patent: 'patent',
  'patent-application': 'patent',

  // Webpage & Online
  webpage: 'webpage',
  'web-page': 'webpage',
  website: 'webpage',
  online: 'webpage',
  blogpost: 'blogPost',
  'blog-post': 'blogPost',

  // Magazines & News
  magazinearticle: 'magazineArticle',
  'magazine-article': 'magazineArticle',
  newspaperarticle: 'newspaperArticle',
  'newspaper-article': 'newspaperArticle',

  // Presentations
  presentation: 'presentation',
  slides: 'presentation',
  talk: 'presentation',
  lecture: 'presentation',

  // Media
  videorecording: 'videoRecording',
  video: 'videoRecording',
  audiorecording: 'audioRecording',
  audio: 'audioRecording',
  podcast: 'podcast',
  film: 'film',
  movie: 'film',
  artwork: 'artwork',
};

/**
 * Normalizes an item type string against canonical Schema V4.2 item types.
 */
export function normalizeCanonicalItemType(
  rawType: string | undefined | null,
  canonicalTypes?: Record<string, unknown>,
): string {
  if (!rawType || typeof rawType !== 'string') {
    return 'journalArticle';
  }

  const trimmed = rawType.trim();
  const lower = trimmed.toLowerCase();

  // Check direct case-insensitive match against canonical types if provided
  if (canonicalTypes) {
    const matchedKey = Object.keys(canonicalTypes).find(
      (k) => k.toLowerCase() === lower,
    );
    if (matchedKey) return matchedKey;
  }

  // Check alias dictionary
  if (ITEM_TYPE_ALIASES[lower]) {
    return ITEM_TYPE_ALIASES[lower];
  }

  const cleaned = lower.replace(/[\s_-]+/g, '');
  if (ITEM_TYPE_ALIASES[cleaned]) {
    return ITEM_TYPE_ALIASES[cleaned];
  }

  return 'journalArticle';
}
