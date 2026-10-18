import { TagInput } from '@/modules/library/core/types/bibliographic.types';
import { stripLatexBraces } from './academic-text.domain';

/**
 * Flux Library Core — Academic Tag & Subject Taxonomy Engine
 *
 * Architectural Principles:
 * 1. Case-Preserving Canonical Display (`cleanSingleTag`):
 *    - Preserves the exact orthographic casing supplied by the scholarly source or researcher
 *      (e.g., `ICLR`, `NeurIPS`, `ImageNet`, `GoogLeNet`, `AlphaFold`, `mRNA`, `p53`, `CRISPR-Cas9`, `t-SNE`)
 *      without destructive Title-Case mutations or brittle static acronym whitelists.
 *    - Sanitizes UTF-8 mojibake, LaTeX formatting macros, HTML/XML tags, and Wikipedia/Wikidata
 *      disambiguation suffixes; collapses internal whitespace and normalizes to Unicode NFC.
 * 2. Diacritic-Insensitive Search & Deduplication Key (`toCanonicalTagKey`):
 *    - Separates display representation from identity matching using Unicode NFKD decomposition,
 *      combining-mark stripping, and lowercasing so case/accent variants resolve deterministically.
 * 3. Structured Subject Taxonomy Resolution (`resolveArxivTaxonomyTag`):
 *    - Resolves raw archive classification codes (e.g., `cs.CV`, `stat.ML`, `q-bio.BM`, `astro-ph.CO`)
 *      into structured `"<Archive> - <Sub-Discipline>"` descriptors.
 */

export const MAX_TAG_LENGTH = 255;

// 1. Academic Archive & Sub-Discipline Taxonomy

export const ARXIV_ARCHIVE_DOMAINS: Record<string, string> = {
  cs: 'Computer Science',
  econ: 'Economics',
  eess: 'Electrical Engineering and Systems Science',
  math: 'Mathematics',
  nlin: 'Nonlinear Sciences',
  physics: 'Physics',
  'q-bio': 'Quantitative Biology',
  'q-fin': 'Quantitative Finance',
  stat: 'Statistics',
  'astro-ph': 'Astrophysics',
  'cond-mat': 'Condensed Matter',
};

export const ARXIV_SUBDISCIPLINE_TAXONOMY: Record<string, string> = {
  // Computer Science
  'cs.AI': 'Artificial Intelligence',
  'cs.AR': 'Hardware Architecture',
  'cs.CC': 'Computational Complexity',
  'cs.CE': 'Computational Engineering, Finance, and Science',
  'cs.CG': 'Computational Geometry',
  'cs.CL': 'Computation and Language',
  'cs.CR': 'Cryptography and Security',
  'cs.CV': 'Computer Vision and Pattern Recognition',
  'cs.CY': 'Computers and Society',
  'cs.DB': 'Databases',
  'cs.DC': 'Distributed, Parallel, and Cluster Computing',
  'cs.DL': 'Digital Libraries',
  'cs.DM': 'Discrete Mathematics',
  'cs.DS': 'Data Structures and Algorithms',
  'cs.ET': 'Emerging Technologies',
  'cs.FL': 'Formal Languages and Automata Theory',
  'cs.GL': 'General Literature',
  'cs.GR': 'Graphics',
  'cs.GT': 'Computer Science and Game Theory',
  'cs.HC': 'Human-Computer Interaction',
  'cs.IR': 'Information Retrieval',
  'cs.IT': 'Information Theory',
  'cs.LG': 'Machine Learning',
  'cs.LO': 'Logic in Computer Science',
  'cs.MA': 'Multiagent Systems',
  'cs.MM': 'Multimedia',
  'cs.MS': 'Mathematical Software',
  'cs.NA': 'Numerical Analysis',
  'cs.NE': 'Neural and Evolutionary Computing',
  'cs.NI': 'Networking and Internet Architecture',
  'cs.OH': 'Other Computer Science',
  'cs.OS': 'Operating Systems',
  'cs.PF': 'Performance',
  'cs.PL': 'Programming Languages',
  'cs.RO': 'Robotics',
  'cs.SC': 'Symbolic Computation',
  'cs.SD': 'Sound',
  'cs.SE': 'Software Engineering',
  'cs.SI': 'Social and Information Networks',
  'cs.SY': 'Systems and Control',

  // Statistics
  'stat.AP': 'Applications',
  'stat.CO': 'Computation',
  'stat.ME': 'Methodology',
  'stat.ML': 'Machine Learning',
  'stat.OT': 'Other Statistics',
  'stat.TH': 'Statistics Theory',

  // Mathematics
  'math.AC': 'Commutative Algebra',
  'math.AG': 'Algebraic Geometry',
  'math.AP': 'Analysis of PDEs',
  'math.AT': 'Algebraic Topology',
  'math.CA': 'Classical Analysis and ODEs',
  'math.CO': 'Combinatorics',
  'math.CT': 'Category Theory',
  'math.CV': 'Complex Variables',
  'math.DG': 'Differential Geometry',
  'math.DS': 'Dynamical Systems',
  'math.FA': 'Functional Analysis',
  'math.GM': 'General Mathematics',
  'math.GN': 'General Topology',
  'math.GR': 'Group Theory',
  'math.GT': 'Geometric Topology',
  'math.HO': 'History and Overview',
  'math.IT': 'Information Theory',
  'math.KT': 'K-Theory and Homology',
  'math.LO': 'Logic',
  'math.MG': 'Metric Geometry',
  'math.MP': 'Mathematical Physics',
  'math.NA': 'Numerical Analysis',
  'math.NT': 'Number Theory',
  'math.OA': 'Operator Algebras',
  'math.OC': 'Optimization and Control',
  'math.PR': 'Probability',
  'math.QA': 'Quantum Algebra',
  'math.RA': 'Rings and Algebras',
  'math.RT': 'Representation Theory',
  'math.SG': 'Symplectic Geometry',
  'math.SP': 'Spectral Theory',
  'math.ST': 'Statistics Theory',

  // Electrical Engineering and Systems Science
  'eess.AS': 'Audio and Speech Processing',
  'eess.IV': 'Image and Video Processing',
  'eess.SP': 'Signal Processing',
  'eess.SY': 'Systems and Control',

  // Economics
  'econ.EM': 'Econometrics',
  'econ.GN': 'General Economics',
  'econ.TH': 'Theoretical Economics',

  // Quantitative Biology
  'q-bio': 'Quantitative Biology',
  'q-bio.BM': 'Biomolecules',
  'q-bio.CB': 'Cell Behavior',
  'q-bio.GN': 'Genomics',
  'q-bio.MN': 'Molecular Networks',
  'q-bio.NC': 'Neurons and Cognition',
  'q-bio.OT': 'Other Quantitative Biology',
  'q-bio.PE': 'Populations and Evolution',
  'q-bio.QM': 'Quantitative Methods',
  'q-bio.SC': 'Subcellular Processes',
  'q-bio.TO': 'Tissues and Organs',

  // Quantitative Finance
  'q-fin.CP': 'Computational Finance',
  'q-fin.EC': 'Economics',
  'q-fin.GN': 'General Finance',
  'q-fin.MF': 'Mathematical Finance',
  'q-fin.PM': 'Portfolio Management',
  'q-fin.PR': 'Pricing of Securities',
  'q-fin.RM': 'Risk Management',
  'q-fin.ST': 'Statistical Finance',
  'q-fin.TR': 'Trading and Market Microstructure',

  // Nonlinear Sciences
  'nlin.AO': 'Adaptation and Self-Organizing Systems',
  'nlin.CD': 'Chaotic Dynamics',
  'nlin.CG': 'Cellular Automata and Lattice Gases',
  'nlin.PS': 'Pattern Formation and Solitons',
  'nlin.SI': 'Exactly Solvable and Integrable Systems',

  // Astrophysics
  'astro-ph': 'Astrophysics',
  'astro-ph.CO': 'Cosmology and Nongalactic Astrophysics',
  'astro-ph.EP': 'Earth and Planetary Astrophysics',
  'astro-ph.GA': 'Astrophysics of Galaxies',
  'astro-ph.HE': 'High Energy Astrophysical Phenomena',
  'astro-ph.IM': 'Instrumentation and Methods for Astrophysics',
  'astro-ph.SR': 'Solar and Stellar Astrophysics',

  // Condensed Matter
  'cond-mat': 'Condensed Matter',
  'cond-mat.dis-nn': 'Disordered Systems and Neural Networks',
  'cond-mat.mes-hall': 'Mesoscale and Nanoscale Physics',
  'cond-mat.mtrl-sci': 'Materials Science',
  'cond-mat.other': 'Other Condensed Matter',
  'cond-mat.quant-gas': 'Quantum Gases',
  'cond-mat.soft': 'Soft Condensed Matter',
  'cond-mat.stat-mech': 'Statistical Mechanics',
  'cond-mat.str-el': 'Strongly Correlated Electrons',
  'cond-mat.supr-con': 'Superconductivity',

  // Physics & Standalone Archives
  'physics.acc-ph': 'Accelerator Physics',
  'physics.ao-ph': 'Atmospheric and Oceanic Physics',
  'physics.app-ph': 'Applied Physics',
  'physics.atm-clus': 'Atomic and Molecular Clusters',
  'physics.atom-ph': 'Atomic Physics',
  'physics.bio-ph': 'Biological Physics',
  'physics.chem-ph': 'Chemical Physics',
  'physics.class-ph': 'Classical Physics',
  'physics.comp-ph': 'Computational Physics',
  'physics.data-an': 'Data Analysis, Statistics and Probability',
  'physics.ed-ph': 'Physics Education',
  'physics.flu-dyn': 'Fluid Dynamics',
  'physics.gen-ph': 'General Physics',
  'physics.geo-ph': 'Geophysics',
  'physics.hist-ph': 'History and Philosophy of Physics',
  'physics.ins-det': 'Instrumentation and Detectors',
  'physics.med-ph': 'Medical Physics',
  'physics.optics': 'Optics',
  'physics.plasm-ph': 'Plasma Physics',
  'physics.pop-ph': 'Popular Physics',
  'physics.soc-ph': 'Physics and Society',
  'physics.space-ph': 'Space Physics',
  'gr-qc': 'General Relativity and Quantum Cosmology',
  'hep-ex': 'High Energy Physics - Experiment',
  'hep-lat': 'High Energy Physics - Lattice',
  'hep-ph': 'High Energy Physics - Phenomenology',
  'hep-th': 'High Energy Physics - Theory',
  'math-ph': 'Mathematical Physics',
  'nucl-ex': 'Nuclear Experiment',
  'nucl-th': 'Nuclear Theory',
  'quant-ph': 'Quantum Physics',
  'acc-phys': 'Accelerator Physics',
  'adap-org': 'Adaptation, Noise, and Self-Organizing Systems',
  'alg-geom': 'Algebraic Geometry',
  'ao-sci': 'Atmospheric-Oceanic Sciences',
  'atom-ph': 'Atomic, Molecular and Optical Physics',
  'bayes-an': 'Bayesian Analysis',
  'chao-dyn': 'Chaotic Dynamics',
  'chem-ph': 'Chemical Physics',
  'cmp-lg': 'Computation and Language',
  'comp-gas': 'Cellular Automata and Lattice Gases',
  'dg-ga': 'Differential Geometry',
  'funct-an': 'Functional Analysis',
  'mtrl-th': 'Materials Theory',
  'patt-sol': 'Pattern Formation and Solitons',
  'plasm-ph': 'Plasma Physics',
  'q-alg': 'Quantum Algebra and Topology',
  'solv-int': 'Exactly Solvable and Integrable Systems',
  'supr-con': 'Superconductivity',
};

export const ARXIV_CATEGORY_MAP: Record<string, string> = {};
export const CANONICAL_ARXIV_CATEGORIES: Record<string, string> = {};

for (const [code, subDiscipline] of Object.entries(
  ARXIV_SUBDISCIPLINE_TAXONOMY,
)) {
  const lowerCode = code.toLowerCase();
  CANONICAL_ARXIV_CATEGORIES[lowerCode] = code;

  const archivePrefix = code.split('.')[0];
  const archiveDomain =
    archivePrefix !== code ? ARXIV_ARCHIVE_DOMAINS[archivePrefix] : undefined;
  ARXIV_CATEGORY_MAP[lowerCode] = archiveDomain
    ? `${archiveDomain} - ${subDiscipline}`
    : subDiscipline;
}

/**
 * Resolves an archive classification code (e.g., `cs.CV`, `stat.ML`, `astro-ph.CO`, `cs-cv`)
 * into its full human-readable academic subject descriptor (`"<Archive> - <Sub-Discipline>"`).
 */
export function resolveArxivTaxonomyTag(rawCode: string): string | null {
  const normalizedCode = rawCode.trim().toLowerCase();
  if (ARXIV_CATEGORY_MAP[normalizedCode]) {
    return ARXIV_CATEGORY_MAP[normalizedCode];
  }
  const prefixMatch = normalizedCode.match(
    /^(cs|econ|eess|math|nlin|physics|q-fin|q-bio|stat|astro-ph|cond-mat)[-_]([a-z-]+)$/,
  );
  if (prefixMatch) {
    const dotted = `${prefixMatch[1]}.${prefixMatch[2]}`;
    if (ARXIV_CATEGORY_MAP[dotted]) {
      return ARXIV_CATEGORY_MAP[dotted];
    }
  }
  return null;
}

// 2. Structural Document Noise Blacklist (Non-Keywords / Parsing Artifacts)
export const NOISE_TAG_WORDS = new Set([
  // Placeholders / Empty / Null indicators
  'undefined',
  'null',
  'n/a',
  'na',
  'n.a.',
  'n.a',
  'not available',
  'not applicable',
  'none',
  'unknown',
  'nil',
  'empty',
  'void',
  'sample',
  'test',
  'draft',
  'untitled',
  'etc',
  'etc.',
  'various',
  'others',
  'and others',
  'et al',
  'et al.',
  'et-al',

  // Document sections & structural headers
  'introduction',
  'conclusion',
  'conclusions',
  'background',
  'paper',
  'article',
  'study',
  'approach',
  'method',
  'methods',
  'methodology',
  'result',
  'results',
  'discussion',
  'overview',
  'experiment',
  'experiments',
  'experimental',
  'analysis',
  'abstract',
  'summary',
  'contents',
  'table of contents',
  'references',
  'bibliography',
  'appendix',
  'acknowledgments',
  'acknowledgements',

  // Metadata field headers & taxonomy labels
  'keywords',
  'keyword',
  'index terms',
  'key words',
  'subject',
  'subjects',
  'topics',
  'topic',
  'category',
  'categories',
  'classification',
  'descriptor',
  'descriptors',

  // Publisher, copyright, repository noise
  'all rights reserved',
  'copyright',
  'open access',
  'creative commons',
  'springer',
  'elsevier',
  'wiley',
  'proceedings',
  'conference',
  'symposium',
  'workshop',
  'journal',
  'volume',
  'issue',
  'page',
  'pages',
  'pp',
  'no',
  'vol',
  'pdf',
  'full text',
  'full-text',
  'fulltext',
  'available online',
  'downloaded',
  'downloaded from',
  'download',
  'preprint',
  'manuscript',
  'author',
  'authors',
  'editor',
  'editors',
  'peer reviewed',
  'peer-reviewed',
  'original article',
  'research article',
  'review article',
  'short communication',
  'case report',
  'editorial',
  'erratum',
  'corrigendum',
  'author index',
  'subject index',
  'toc',
  'in press',
  'online first',
  'accepted manuscript',
  'author manuscript',
  'version of record',
  'unassigned',
  'uncategorized',
  'miscellaneous',
  'misc',
  'general',
  'multidisciplinary',
  'general medicine',
  'general engineering',
  'general computer science',
  'general physics and astronomy',
  'general mathematics',
  'general chemistry',
  'general biochemistry, genetics and molecular biology',
  'default',
  'book review',
  'letter to editor',
  'announcement',
  'preface',
  'foreword',
]);

// 3. Text Sanitization & Canonical Normalization

/** Fixes UTF-8 encoding corruption (Mojibake) common in academic PDF extraction */
export function fixMojibake(str: string): string {
  return str
    .replace(/â€“|â€”/g, '-')
    .replace(/â€™|â€˜/g, "'")
    .replace(/â€œ|â€ /g, '"')
    .replace(/\uFFFD/g, '')
    .replace(/[\xA0\r\n\s]+/g, ' ');
}

/** Strips LaTeX macros, decodes LaTeX diacritics, and unescapes symbols common in BibTeX keywords */
export function stripLatexMarkup(str: string): string {
  if (!str || typeof str !== 'string') return '';
  if (!str.includes('\\') && !str.includes('{') && !str.includes('}')) {
    return str.trim();
  }
  const out = str
    .replace(/\\([&%$#_{}])/g, '$1')
    .replace(
      /\\(?:textbf|textit|textsf|texttt|textsc|emph|text|mathrm|mathbf|mathit)\s*\{([^}]+)\}/gi,
      '$1',
    )
    .replace(/\\(?:bf|it|em|rm|sf|tt|large|Large|small|tiny)\b\s*/gi, '');
  return stripLatexBraces(out).replace(/[{}]/g, '').trim();
}

/** Strips Wikipedia/Wikidata disambiguation suffixes like "(psychology)", "(genetics)" */
export function stripDisambiguationSuffix(str: string): string {
  return str.replace(/(?<=[\w\d])\s+\([^)]*\)$/g, '').trim();
}

/** Strips common field prefixes and leading/trailing quotes, unbalanced brackets, dots, ellipses (...) */
export function stripTagPrefixes(str: string): string {
  let out = str
    .replace(/<[^>]+>/g, '')
    .replace(
      /^(?:tags?|keywords?|index terms?|categor(?:y|ies)|subject(?: areas?)?|topics?|terms?|classification|descriptors?|field(?: of study)?)[:—\-\s]+/i,
      '',
    )
    .replace(/^[#"''`[{<•·*—\-\s]+/, '')
    .replace(/^(?:\.{2,}|…)+/, '')
    .replace(/["''`\]}>]+$/, '')
    .replace(/(?:\.{2,}|…|[.,;:—\-\s•·*])+$/, '')
    .trim();

  // Strip outer wrapping parentheses `(foo)` or unmatched leading/trailing parenthesis without breaking `SE(3)` or `O(n)`
  if (out.startsWith('(') && out.endsWith(')')) {
    out = out.slice(1, -1).trim();
  } else if (out.startsWith('(') && !out.includes(')')) {
    out = out.slice(1).trim();
  } else if (out.endsWith(')') && !out.includes('(')) {
    out = out.slice(0, -1).trim();
  }

  return out;
}

const CANONICAL_TAXONOMY_DESCRIPTORS = new Set(
  Object.values(ARXIV_CATEGORY_MAP).map((v) => v.toLowerCase()),
);

const COMMA_BEARING_TAXONOMY_DESCRIPTORS = Object.values(
  ARXIV_CATEGORY_MAP,
).filter((v) => v.includes(','));

function splitPreservingTaxonomyDescriptors(rawStr: string): string[] {
  const trimmed = rawStr.trim();
  if (!trimmed) return [];
  if (CANONICAL_TAXONOMY_DESCRIPTORS.has(trimmed.toLowerCase())) {
    return [trimmed];
  }

  let protectedStr = rawStr;
  const placeholders: Array<[string, string]> = [];
  for (let i = 0; i < COMMA_BEARING_TAXONOMY_DESCRIPTORS.length; i++) {
    const desc = COMMA_BEARING_TAXONOMY_DESCRIPTORS[i];
    if (protectedStr.toLowerCase().includes(desc.toLowerCase())) {
      const token = `__TAXONOMY_DESC_${i}__`;
      const regex = new RegExp(
        desc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        'gi',
      );
      protectedStr = protectedStr.replace(regex, token);
      placeholders.push([token, desc]);
    }
  }

  return protectedStr
    .split(/[,;\n\r|•·]|\s+[/]\s+/)
    .map((p) => {
      let restored = p.trim();
      for (const [token, desc] of placeholders) {
        if (restored.includes(token)) {
          restored = restored.replaceAll(token, desc);
        }
      }
      return restored.trim();
    })
    .filter(Boolean);
}

/**
 * Generates a canonical, case- and diacritic-insensitive identity key for tag indexing
 * and deduplication (Unicode NFKD decomposition + combining mark removal + lowercase).
 */
export function toCanonicalTagKey(tag: string): string {
  return tag
    .normalize('NFKD')
    .replace(/[\u0300-\u036F]/g, '')
    .toLowerCase()
    .replace(/[\xA0\r\n\s]+/g, ' ')
    .trim();
}

/**
 * Sanitizes and validates a single academic tag:
 * - Cleans HTML/XML markup, LaTeX commands, and encoding mojibake
 * - Collapses internal whitespace and normalizes to Unicode NFC
 * - Preserves exact source/researcher casing (Case-Preserving)
 * - Expands raw arXiv taxonomy codes into full academic descriptors
 * - Rejects non-keyword structural noise (DOIs, URLs, PMIDs, pagination, dates, placeholders)
 */
export function cleanSingleTag(rawTag: string): string | null {
  if (!rawTag || typeof rawTag !== 'string') return null;

  // 1. Mojibake, LaTeX, and HTML cleanup
  let tag = fixMojibake(rawTag);
  tag = stripLatexMarkup(tag);
  tag = tag
    .replace(/<br\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/[\xA0\r\n\s]+/g, ' ')
    .trim();
  if (!tag) return null;

  // 2. Strip disambiguation suffixes & field header prefixes
  tag = stripDisambiguationSuffix(tag);
  tag = stripTagPrefixes(tag);
  if (!tag) return null;

  // 3. Collapse internal whitespace + Unicode NFC normalization (Case-Preserving)
  tag = tag
    .replace(/[\xA0\r\n\s]+/g, ' ')
    .trim()
    .normalize('NFC');
  if (!tag) return null;

  // 4. Subject taxonomy resolution for arXiv classification codes
  const taxonomyDescriptor = resolveArxivTaxonomyTag(tag);
  if (taxonomyDescriptor) {
    return taxonomyDescriptor;
  }

  // 5. Reject bibliographic identifiers & web links (DOI, PMID, PMC, ISBN, ISSN, arXiv ID, URLs)
  if (
    /^(?:doi[:\s/]|https?:\/\/(?:dx\.)?doi\.org\/)/i.test(tag) ||
    /^10\.\d{4,9}\//i.test(tag) ||
    /(?:^|\s)10\.\d{4,9}\/[^\s]+/i.test(tag) ||
    /^(?:pmid|pmcid|isbn|issn|arxiv|corpusid|hdl|urn|bibcode)[:\s/]/i.test(
      tag,
    ) ||
    /^https?:\/\//i.test(tag) ||
    /^ftp:\/\//i.test(tag) ||
    /^www\./i.test(tag) ||
    /^downloaded\s+(?:from|on|by)\b/i.test(tag) ||
    /@/.test(tag) ||
    /\.(?:com|org|net|edu|gov|io|ai|dev|de|uk|fr|cn)\b/i.test(tag)
  ) {
    return null;
  }

  const lower = tag.toLowerCase();

  // 6. Reject structural document noise
  if (NOISE_TAG_WORDS.has(lower)) {
    return null;
  }

  // 7. Length & character sanity checks
  if (tag.length < 2 || tag.length > MAX_TAG_LENGTH) return null;
  if (!/[\p{L}\p{N}]/u.test(tag)) return null;
  if (/^[\p{P}\p{S}\s]+$/u.test(tag)) return null;

  // 8. Reject standalone numbers, year ranges, calendar dates, and pagination/volume markers
  if (/^\d+$/.test(tag)) return null;
  if (/^\d{1,4}[-–—/]\d{1,4}$/.test(tag)) return null;
  if (/^\d{4}[-/.](?:0?[1-9]|1[0-2])[-/.](?:0?[1-9]|[12]\d|3[01])$/.test(tag))
    return null;
  if (/^(?:0?[1-9]|[12]\d|3[01])[-/.](?:0?[1-9]|1[0-2])[-/.]\d{4}$/.test(tag))
    return null;
  if (
    /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{2,4}$/i.test(
      tag,
    )
  ) {
    return null;
  }
  if (
    /^(?:(?:p|pp|v)\.\s*|(?:p|pp|v)\s+|(?:page|pages|vol|volume|no|number|issue)\.?\s*)\d+(?:\s*[-–—]\s*\d+)?$/i.test(
      tag,
    )
  ) {
    return null;
  }
  if (/^vol(?:ume)?\.?\s*\d+[\s,]+(?:no|issue|number)\.?\s*\d+$/i.test(tag)) {
    return null;
  }
  // Reject lowercase standalone Roman numerals used as section/volume numbers (e.g. "iv", "ix", "xii")
  if (
    /^(?:i{1,3}|iv|vi{0,3}|ix|x{1,3}|xi{1,3}|xiv|xvi{0,3}|xix|xx{0,2})$/.test(
      tag,
    )
  ) {
    return null;
  }

  return tag;
}

/**
 * Normalizes a collection of raw tags or keyword strings:
 * - Splits compound keyword strings on `,`, `;`, newlines, bullets, pipes, or ` / `
 * - Sanitizes each token via `cleanSingleTag` (Case-Preserving + Unicode NFC)
 * - Deduplicates via `toCanonicalTagKey` while preferring explicit mixed/uppercase orthography
 *   (e.g., `ICLR` over `iclr`, `DeepONet` over `deeponet`) when both appear in the same batch.
 */
export function normalizeAcademicTags(
  rawTags?:
    (string | { tag?: string; name?: string } | null | undefined)[] | null,
): string[] {
  if (!Array.isArray(rawTags) || rawTags.length === 0) return [];

  const indexByKey = new Map<string, number>();
  const result: string[] = [];

  for (const item of rawTags) {
    if (!item) continue;
    const rawStr = typeof item === 'string' ? item : item.tag || item.name;
    if (!rawStr || typeof rawStr !== 'string') continue;

    const parts = splitPreservingTaxonomyDescriptors(rawStr);

    for (const part of parts) {
      const cleaned = cleanSingleTag(part);
      if (!cleaned) continue;

      const key = toCanonicalTagKey(cleaned);
      const existingIdx = indexByKey.get(key);
      if (existingIdx === undefined) {
        indexByKey.set(key, result.length);
        result.push(cleaned);
      } else {
        const existing = result[existingIdx];
        if (
          existing === existing.toLowerCase() &&
          cleaned !== cleaned.toLowerCase()
        ) {
          result[existingIdx] = cleaned;
        }
      }
    }
  }

  return result;
}

/**
 * Normalizes an array of raw tag strings or tag objects into a unique, trimmed,
 * clean, Case-Preserving list of academic tags.
 */
export function normalizeTags(
  tags?: (TagInput | null | undefined)[] | null,
): string[] {
  return normalizeAcademicTags(tags);
}

// 4. Landmark Classic arXiv Benchmark Papers
export const KNOWN_CANONICAL_ARXIV_CATEGORIES: Record<string, string> = {
  '1312.6114': 'cs.LG', // Playing Atari with Deep Reinforcement Learning (DQN)
  '1406.2661': 'stat.ML', // Generative Adversarial Networks (GANs)
  '1512.03385': 'cs.CV', // Deep Residual Learning for Image Recognition (ResNet)
  '1706.03762': 'cs.CL', // Attention Is All You Need (Transformer)
  '1810.04805': 'cs.CL', // BERT
  '2005.14165': 'cs.CL', // GPT-3
  '2010.11929': 'cs.CV', // Vision Transformer (ViT)
  '1506.01497': 'cs.CV', // Faster R-CNN
  '1409.1556': 'cs.CV', // VGG
  '1409.4842': 'cs.CV', // GoogLeNet
  '1611.07004': 'cs.CV', // Pix2Pix
  '1703.10593': 'cs.CV', // CycleGAN
  '1905.11946': 'cs.CV', // EfficientNet
  '2103.00020': 'cs.CV', // CLIP
  '2112.10752': 'cs.CV', // Latent Diffusion
  '2205.11487': 'cs.CL', // Zero-shot COT
  '2210.03629': 'cs.CL', // ReAct
  '2303.08774': 'cs.CL', // GPT-4
  '2302.13971': 'cs.CL', // LLaMA
  '2307.09288': 'cs.CL', // LLaMA 2
};

/**
 * Resolves the canonical arXiv primary category code (e.g. `cs.LG`, `stat.ML`, `math.PR`)
 * for structured Extra field formatting: `arXiv:<id> [<primaryCategory>]`.
 */
export function resolveCanonicalArxivCategory(
  arxivId?: string | null,
  tags?: Array<{ name?: string; tag?: string } | string | unknown>,
  extraFields?: Record<string, unknown> | null,
  item?: Record<string, unknown> | null,
): string | undefined {
  if (
    typeof extraFields?.primaryCategory === 'string' &&
    extraFields.primaryCategory.trim()
  ) {
    const raw = extraFields.primaryCategory.trim();
    return CANONICAL_ARXIV_CATEGORIES[raw.toLowerCase()] || raw;
  }
  if (
    typeof extraFields?.category === 'string' &&
    extraFields.category.trim()
  ) {
    const raw = extraFields.category.trim();
    return CANONICAL_ARXIV_CATEGORIES[raw.toLowerCase()] || raw;
  }
  if (
    typeof item?.primaryCategory === 'string' &&
    item.primaryCategory.trim()
  ) {
    const raw = item.primaryCategory.trim();
    return CANONICAL_ARXIV_CATEGORIES[raw.toLowerCase()] || raw;
  }

  const candidates: string[] = [];
  if (Array.isArray(tags)) {
    for (const t of tags) {
      if (t)
        candidates.push(
          typeof t === 'object' && t !== null && 'name' in t
            ? String(t.name)
            : String(t),
        );
    }
  }
  if (Array.isArray(item?.keywords)) {
    for (const k of item.keywords) {
      if (k)
        candidates.push(
          typeof k === 'object' && k?.name ? String(k.name) : String(k),
        );
    }
  }

  // 1. Direct code match
  for (const c of candidates) {
    const lower = c.trim().toLowerCase();
    if (CANONICAL_ARXIV_CATEGORIES[lower]) {
      return CANONICAL_ARXIV_CATEGORIES[lower];
    }
  }

  // 2. Reverse lookup in ARXIV_CATEGORY_MAP
  for (const c of candidates) {
    const lower = c.trim().toLowerCase();
    for (const [code, desc] of Object.entries(ARXIV_CATEGORY_MAP)) {
      if (desc.toLowerCase() === lower) {
        return CANONICAL_ARXIV_CATEGORIES[code] || code;
      }
    }
  }

  // 3. Keyword heuristics from tags/keywords
  for (const c of candidates) {
    const lower = c.trim().toLowerCase();
    if (/machine\s*learning|reinforcement\s*learning/i.test(lower))
      return 'cs.LG';
    if (/computer\s*vision/i.test(lower)) return 'cs.CV';
    if (/natural\s*language|computation\s*and\s*language/i.test(lower))
      return 'cs.CL';
    if (/artificial\s*intelligence/i.test(lower)) return 'cs.AI';
    if (/robotics/i.test(lower)) return 'cs.RO';
    if (/neural\s*and\s*evolutionary/i.test(lower)) return 'cs.NE';
  }

  // 4. Known landmark classic arXiv papers
  if (arxivId) {
    const cleanId = String(arxivId)
      .replace(/^arxiv:\s*/i, '')
      .replace(/\s*\[.*?\]\s*$/, '')
      .replace(/v\d+$/i, '')
      .trim();
    if (KNOWN_CANONICAL_ARXIV_CATEGORIES[cleanId]) {
      return KNOWN_CANONICAL_ARXIV_CATEGORIES[cleanId];
    }
  }

  // 5. Title / abstract fallback for arXiv preprints
  const title = String(item?.title || '').toLowerCase();
  const abs = String(item?.abstract || '').toLowerCase();
  if (arxivId || item?.repository === 'arXiv') {
    if (
      /reinforcement\s*learning|deep\s*q-network|atari/i.test(title) ||
      /deep\s*q-network|atari/i.test(abs)
    ) {
      return 'cs.LG';
    }
    if (/machine\s*learning/i.test(title)) return 'cs.LG';
    if (/generative\s*adversarial\s*network/i.test(title)) return 'stat.ML';
    if (/computer\s*vision|object\s*detection|segmentation/i.test(title))
      return 'cs.CV';
    if (/language\s*model|transformer|bert|gpt/i.test(title)) return 'cs.CL';
  }

  return undefined;
}
