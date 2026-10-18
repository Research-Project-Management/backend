import { SCHEMA_V42_DATA } from '@/modules/library/core/types/schema.constants';

export const BANNED_STRINGS = new Set([
  'undefined',
  'null',
  'n/a',
  'na',
  'none',
  'unknown',
  '',
]);

export const HTML_ENTITY_CODEPOINTS: Record<string, number> = (() => {
  const map: Record<string, number> = {
    amp: 0x26,
    lt: 0x3c,
    gt: 0x3e,
    quot: 0x22,
    apos: 0x27,
    nbsp: 0x20, // decoded as a plain space on purpose (whitespace collapsing)
    ensp: 0x20,
    emsp: 0x20,
    thinsp: 0x20,
    shy: 0, // soft hyphen → removed
    zwnj: 0,
    zwj: 0,
    ndash: 0x2013,
    mdash: 0x2014,
    minus: 0x2212,
    hyphen: 0x2010,
    lsquo: 0x2018,
    rsquo: 0x2019,
    sbquo: 0x201a,
    ldquo: 0x201c,
    rdquo: 0x201d,
    bdquo: 0x201e,
    laquo: 0xab,
    raquo: 0xbb,
    lsaquo: 0x2039,
    rsaquo: 0x203a,
    hellip: 0x2026,
    bull: 0x2022,
    middot: 0xb7,
    prime: 0x2032,
    Prime: 0x2033,
    dagger: 0x2020,
    Dagger: 0x2021,
    permil: 0x2030,
    copy: 0xa9,
    reg: 0xae,
    trade: 0x2122,
    sect: 0xa7,
    para: 0xb6,
    cent: 0xa2,
    pound: 0xa3,
    yen: 0xa5,
    euro: 0x20ac,
    iexcl: 0xa1,
    iquest: 0xbf,
    ordf: 0xaa,
    ordm: 0xba,
    plusmn: 0xb1,
    times: 0xd7,
    divide: 0xf7,
    micro: 0xb5,
    deg: 0xb0,
    sup1: 0xb9,
    sup2: 0xb2,
    sup3: 0xb3,
    frac14: 0xbc,
    frac12: 0xbd,
    frac34: 0xbe,
    acute: 0xb4,
    uml: 0xa8,
    cedil: 0xb8,
    macr: 0xaf,
    le: 0x2264,
    ge: 0x2265,
    ne: 0x2260,
    asymp: 0x2248,
    equiv: 0x2261,
    infin: 0x221e,
    sum: 0x2211,
    prod: 0x220f,
    radic: 0x221a,
    part: 0x2202,
    nabla: 0x2207,
    isin: 0x2208,
    larr: 0x2190,
    uarr: 0x2191,
    rarr: 0x2192,
    darr: 0x2193,
    harr: 0x2194,
    szlig: 0xdf,
    yuml: 0xff,
    Yuml: 0x178,
    AElig: 0xc6,
    aelig: 0xe6,
    OElig: 0x152,
    oelig: 0x153,
    Scaron: 0x160,
    scaron: 0x161,
    Zcaron: 0x17d,
    zcaron: 0x17e,
    ETH: 0xd0,
    eth: 0xf0,
    THORN: 0xde,
    thorn: 0xfe,
    sigmaf: 0x3c2,
    thetasym: 0x3d1,
    upsih: 0x3d2,
    piv: 0x3d6,
  };
  // Latin-1 accented letters: lowercase at U+00E0.., uppercase = lowercase - 0x20
  const latin1: Array<[string, number]> = [
    ['agrave', 0xe0],
    ['aacute', 0xe1],
    ['acirc', 0xe2],
    ['atilde', 0xe3],
    ['auml', 0xe4],
    ['aring', 0xe5],
    ['ccedil', 0xe7],
    ['egrave', 0xe8],
    ['eacute', 0xe9],
    ['ecirc', 0xea],
    ['euml', 0xeb],
    ['igrave', 0xec],
    ['iacute', 0xed],
    ['icirc', 0xee],
    ['iuml', 0xef],
    ['ntilde', 0xf1],
    ['ograve', 0xf2],
    ['oacute', 0xf3],
    ['ocirc', 0xf4],
    ['otilde', 0xf5],
    ['ouml', 0xf6],
    ['oslash', 0xf8],
    ['ugrave', 0xf9],
    ['uacute', 0xfa],
    ['ucirc', 0xfb],
    ['uuml', 0xfc],
    ['yacute', 0xfd],
  ];
  for (const [name, cp] of latin1) {
    map[name] = cp;
    map[name.charAt(0).toUpperCase() + name.slice(1)] = cp - 0x20;
  }
  // Greek letters: lowercase U+03B1.., uppercase = lowercase - 0x20
  const greek = [
    'alpha',
    'beta',
    'gamma',
    'delta',
    'epsilon',
    'zeta',
    'eta',
    'theta',
    'iota',
    'kappa',
    'lambda',
    'mu',
    'nu',
    'xi',
    'omicron',
    'pi',
    'rho',
    '', // final sigma slot (handled as sigmaf)
    'sigma',
    'tau',
    'upsilon',
    'phi',
    'chi',
    'psi',
    'omega',
  ];
  greek.forEach((name, idx) => {
    if (!name) return;
    const cp = 0x3b1 + idx;
    map[name] = cp;
    map[name.charAt(0).toUpperCase() + name.slice(1)] = cp - 0x20;
  });
  return map;
})();

export const HTML_ENTITY_REGEX =
  /&(?:([a-zA-Z][a-zA-Z0-9]*)|#(\d+)|#[xX]([0-9a-fA-F]+));/g;

/** Double-encoded tags such as "&lt;i&gt;" or "&amp;lt;sub&amp;gt;". */
export const DOUBLE_ENCODED_TAG_REGEX =
  /&(?:amp;)?lt;(\/?[a-zA-Z][\w:-]*(?:\s[^&<>]*?)?\/?)&(?:amp;)?gt;/g;

/** Inline formatting tags that must be removed WITHOUT inserting whitespace. */
export const INLINE_FORMAT_TAG_REGEX =
  /<\/?(?:jats:|mml:|html:)?(?:i|b|u|em|strong|sub|sup|sc|scp|span|small|tt|italic|bold|underline|font|smallcaps)\b[^>]*>/gi;

export const LATEX_SPECIAL_MACROS: Array<[RegExp, string]> = [
  [/\{\\ss\}|\\ss\b/g, 'ß'],
  [/\{\\SS\}|\\SS\b/g, 'ẞ'],
  [/\{\\ae\}|\\ae\b/g, 'æ'],
  [/\{\\AE\}|\\AE\b/g, 'Æ'],
  [/\{\\oe\}|\\oe\b/g, 'œ'],
  [/\{\\OE\}|\\OE\b/g, 'Œ'],
  [/\{\\aa\}|\\aa\b/g, 'å'],
  [/\{\\AA\}|\\AA\b/g, 'Å'],
  [/\{\\o\}|\\o\b/g, 'ø'],
  [/\{\\O\}|\\O\b/g, 'Ø'],
  [/\{\\l\}|\\l\b/g, 'ł'],
  [/\{\\L\}|\\L\b/g, 'Ł'],
  [/\{\\dj\}|\\dj\b/g, 'đ'],
  [/\{\\DJ\}|\\DJ\b/g, 'Đ'],
  [/\{\\ng\}|\\ng\b/g, 'ŋ'],
  [/\{\\NG\}|\\NG\b/g, 'Ŋ'],
  [/\{\\th\}|\\th\b/g, 'þ'],
  [/\{\\TH\}|\\TH\b/g, 'Þ'],
  [/\{\\dh\}|\\dh\b/g, 'ð'],
  [/\{\\DH\}|\\DH\b/g, 'Ð'],
  [/\\([uvHckr])\\([ij])\b/g, '\\$1{$2}'],
  [/\{\\i\}|\\i\b/g, 'i'],
  [/\{\\j\}|\\j\b/g, 'j'],
  [/\\&/g, '&'],
  [/\\%/g, '%'],
];

export const LATEX_COMBINING_MAP: Record<string, string> = {
  '"': '\u0308', // umlaut / diaeresis
  "'": '\u0301', // acute
  '`': '\u0300', // grave
  '^': '\u0302', // circumflex
  '~': '\u0303', // tilde
  '=': '\u0304', // macron
  '.': '\u0307', // dot above
  u: '\u0306', // breve
  v: '\u030C', // caron / hacek
  H: '\u030B', // double acute
  c: '\u0327', // cedilla
  k: '\u0328', // ogonek
  r: '\u030A', // ring above
  d: '\u0323', // dot below
  b: '\u0331', // macron below
};

export const UNICODE_SUB_MAP: Record<string, string> = {
  '0': '₀',
  '1': '₁',
  '2': '₂',
  '3': '₃',
  '4': '₄',
  '5': '₅',
  '6': '₆',
  '7': '₇',
  '8': '₈',
  '9': '₉',
  '+': '₊',
  '-': '₋',
  '=': '₌',
  '(': '₍',
  ')': '₎',
  a: 'ₐ',
  e: 'ₑ',
  o: 'ₒ',
  x: 'ₓ',
  h: 'ₕ',
  k: 'ₖ',
  l: 'ₗ',
  m: 'ₘ',
  n: 'ₙ',
  p: 'ₚ',
  s: 'ₛ',
  t: 'ₜ',
  i: 'ᵢ',
  j: 'ⱼ',
  r: 'ᵣ',
  u: 'ᵤ',
  v: 'ᵥ',
};

export const UNICODE_SUP_MAP: Record<string, string> = {
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹',
  '+': '⁺',
  '-': '⁻',
  '=': '⁼',
  '(': '⁽',
  ')': '⁾',
  n: 'ⁿ',
  i: 'ⁱ',
  x: 'ˣ',
  y: 'ʸ',
  t: 'ᵗ',
  a: 'ᵃ',
  b: 'ᵇ',
  c: 'ᶜ',
  d: 'ᵈ',
  e: 'ᵉ',
};

export const MATH_BLOCK_REGEX =
  /\$\$[\s\S]*?\$\$|\$(?:\\\$|[^$\n])+\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\s*\\begin\{([a-zA-Z*]+)\}[\s\S]*?\\end\{\1\}\s*/g;

export const ITEM_TYPE_ALIASES: Record<string, string> = {
  preprint: 'preprint',
  'working-paper': 'preprint',
  'working paper': 'preprint',
  eprint: 'preprint',
  'posted-content': 'preprint',
  postedcontent: 'preprint',
  software: 'computerProgram',
  'software-code': 'computerProgram',
  code: 'computerProgram',
  program: 'computerProgram',
  computerprogram: 'computerProgram',
  algorithm: 'computerProgram',
  dataset: 'dataset',
  data: 'dataset',
  database: 'dataset',
  'data-set': 'dataset',
  standard: 'standard',
  norm: 'standard',
  specification: 'standard',
  rfc: 'standard',
  journalarticle: 'journalArticle',
  'journal-article': 'journalArticle',
  article: 'journalArticle',
  paper: 'journalArticle',
  peer_review: 'journalArticle',
  conferencepaper: 'conferencePaper',
  'proceedings-article': 'conferencePaper',
  proceedings: 'conferencePaper',
  conference: 'conferencePaper',
  inproceedings: 'conferencePaper',
  paper_conference: 'conferencePaper',
  book: 'book',
  monograph: 'book',
  'edited-book': 'book',
  booksection: 'bookSection',
  'book-section': 'bookSection',
  'book-chapter': 'bookSection',
  incollection: 'bookSection',
  inbook: 'bookSection',
  chapter: 'bookSection',
  thesis: 'thesis',
  dissertation: 'thesis',
  phdthesis: 'thesis',
  mastersthesis: 'thesis',
  'doctoral-thesis': 'thesis',
  report: 'report',
  'tech-report': 'report',
  techreport: 'report',
  'research-report': 'report',
  whitepaper: 'report',
  patent: 'patent',
  'patent-application': 'patent',
  webpage: 'webpage',
  'web-page': 'webpage',
  website: 'webpage',
  online: 'webpage',
  blogpost: 'blogPost',
  'blog-post': 'blogPost',
  magazinearticle: 'magazineArticle',
  'magazine-article': 'magazineArticle',
  newspaperarticle: 'newspaperArticle',
  'newspaper-article': 'newspaperArticle',
  presentation: 'presentation',
  slides: 'presentation',
  talk: 'presentation',
  lecture: 'presentation',
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
 * Canonical CSL type → Zotero itemType mapping.
 * Based on zotero-schema.json v42 csl.types crosswalk.
 * Single source of truth — replaces duplicate local maps in ris.parser.ts and identify.stage.ts.
 */
export const CSL_TYPE_TO_ITEM_TYPE: Record<string, string> = {
  // Academic
  article: 'journalArticle',
  'article-journal': 'journalArticle',
  'paper-conference': 'conferencePaper',
  chapter: 'bookSection',
  thesis: 'thesis',
  report: 'report',
  dataset: 'dataset',
  software: 'computerProgram',
  standard: 'standard',
  // Books
  book: 'book',
  manuscript: 'manuscript',
  'entry-dictionary': 'dictionaryEntry',
  'entry-encyclopedia': 'encyclopediaArticle',
  // Articles
  'article-magazine': 'magazineArticle',
  'article-newspaper': 'newspaperArticle',
  // Legal
  bill: 'bill',
  legal_case: 'case',
  hearing: 'hearing',
  legislation: 'statute',
  patent: 'patent',
  // Media
  broadcast: 'tvBroadcast',
  graphic: 'artwork',
  interview: 'interview',
  map: 'map',
  motion_picture: 'film',
  song: 'audioRecording',
  speech: 'presentation',
  // Web/Documents
  document: 'document',
  personal_communication: 'letter',
  post: 'forumPost',
  'post-weblog': 'blogPost',
  webpage: 'webpage',
};

interface SchemaItemTypeEntry {
  itemType: string;
  isBibliographic?: boolean;
  isSpecial?: boolean;
}

export const BIBLIOGRAPHIC_ITEM_TYPES: string[] = (
  Object.values(SCHEMA_V42_DATA.itemTypes) as SchemaItemTypeEntry[]
)
  .filter((t) => Boolean(t.isBibliographic))
  .map((t) => t.itemType);

export const SPECIAL_ITEM_TYPES = (
  Object.values(SCHEMA_V42_DATA.itemTypes) as SchemaItemTypeEntry[]
)
  .filter((t) => Boolean(t.isSpecial))
  .map((t) => t.itemType) as ['attachment', 'note', 'annotation'];

export const CANONICAL_ITEM_TYPES = new Set<string>(
  Object.keys(SCHEMA_V42_DATA.itemTypes),
);

export const SPECIAL_CASE_WORDS: Record<string, string> = {
  arxiv: 'arXiv',
  biorxiv: 'bioRxiv',
  medrxiv: 'medRxiv',
  latex: 'LaTeX',
  bibtex: 'BibTeX',
  fmri: 'fMRI',
  mrna: 'mRNA',
  't-sne': 't-SNE',
  pytorch: 'PyTorch',
  tensorflow: 'TensorFlow',
  openai: 'OpenAI',
  chatgpt: 'ChatGPT',
  ios: 'iOS',
  macos: 'macOS',
  phd: 'PhD',
  ieee: 'IEEE',
  acm: 'ACM',
  nature: 'Nature',
  science: 'Science',
};

export const COMMON_ACADEMIC_ACRONYMS = new Set([
  'AI',
  'ML',
  'DL',
  'RL',
  'NLP',
  'CV',
  'NLU',
  'NLG',
  'LLM',
  'LLMS',
  'SLM',
  'SLMS',
  'VLM',
  'VLMS',
  'CNN',
  'CNNS',
  'RNN',
  'RNNS',
  'GNN',
  'GNNS',
  'GAN',
  'GANS',
  'VAE',
  'VAES',
  'BERT',
  'GPT',
  'CLIP',
  'LSTM',
  'SVM',
  'RAG',
  'COT',
  'TOT',
  'DQN',
  'PPO',
  'DDPG',
  'SAC',
  'DNA',
  'RNA',
  'CRISPR',
  'COVID',
  'COVID-19',
  'SARS',
  'MERS',
  'HIV',
  'PCR',
  'EEG',
  'ECG',
  'MRI',
  'CT',
  'PET',
  'API',
  'APIS',
  'REST',
  'HTTP',
  'HTTPS',
  'URL',
  'URI',
  'SQL',
  'NOSQL',
  'CPU',
  'CPUS',
  'GPU',
  'GPUS',
  'TPU',
  'TPUS',
  'RAM',
  'ROM',
  '2D',
  '3D',
  '4D',
  '5G',
  '6G',
  'DOI',
  'ISBN',
  'ISSN',
  'CSL',
  'PDF',
  'OCR',
  'XML',
  'HTML',
  'JSON',
  'USA',
  'UK',
  'EU',
  'UN',
  'WHO',
  'NIH',
  'NSF',
  'NASA',
  'DARPA',
  'I',
  'II',
  'III',
  'IV',
  'V',
  'VI',
  'VII',
  'VIII',
  'IX',
  'X',
  'XI',
  'XII',
]);

export const MINOR_WORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'but',
  'or',
  'nor',
  'for',
  'yet',
  'so',
  'as',
  'at',
  'by',
  'from',
  'in',
  'into',
  'of',
  'off',
  'on',
  'onto',
  'out',
  'over',
  'per',
  'to',
  'up',
  'via',
  'with',
]);

export const TITLE_SIMILARITY_STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'of',
  'and',
  'or',
  'in',
  'on',
  'for',
  'to',
  'with',
  'by',
  'at',
  'from',
  'via',
]);

/** Minimum similarity for accepting a title-search hit from an external provider. */
export const TITLE_MATCH_THRESHOLD = 0.85;

export const BOT_CHALLENGE_TITLE_RE =
  /client challenge|just a moment|attention required|access denied|are you a robot|verify you are human|captcha|security check|ddos-guard|please wait|cloudflare|bot verification|request blocked|unusual traffic/i;

export const BOT_CHALLENGE_HTML_RE =
  /cf-challenge|_cf_chl|challenge-platform|perimeterx|px-captcha|datadome|captcha-delivery|cf-browser-verification/i;
