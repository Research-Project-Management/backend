import { TagInput } from '../types/tags.types';

/**
 * Academic Tag Normalizer
 * Self-hosted, zero-dependency academic taxonomy resolution, tag cleanup,
 * mojibake fixing, and casing standardization.
 */

// ── 1. arXiv Taxonomy to Zotero-Standard Human-Readable Academic Fields ─────────
const ARXIV_CATEGORY_MAP: Record<string, string> = {
  // Computer Science
  'cs.ai': 'Computer Science - Artificial Intelligence',
  'cs.ar': 'Computer Science - Hardware Architecture',
  'cs.cc': 'Computer Science - Computational Complexity',
  'cs.ce': 'Computer Science - Computational Engineering',
  'cs.cg': 'Computer Science - Computational Geometry',
  'cs.cl': 'Computer Science - Computation and Language',
  'cs.cr': 'Computer Science - Cryptography and Security',
  'cs.cv': 'Computer Science - Computer Vision and Pattern Recognition',
  'cs.cy': 'Computer Science - Computers and Society',
  'cs.db': 'Computer Science - Databases',
  'cs.dc': 'Computer Science - Distributed and Cluster Computing',
  'cs.dl': 'Computer Science - Digital Libraries',
  'cs.dm': 'Computer Science - Discrete Mathematics',
  'cs.ds': 'Computer Science - Data Structures and Algorithms',
  'cs.et': 'Computer Science - Emerging Technologies',
  'cs.fl': 'Computer Science - Formal Languages and Automata',
  'cs.gl': 'Computer Science - General Literature',
  'cs.gr': 'Computer Science - Graphics',
  'cs.gt': 'Computer Science - Computer Science and Game Theory',
  'cs.hc': 'Computer Science - Human-Computer Interaction',
  'cs.ir': 'Computer Science - Information Retrieval',
  'cs.it': 'Computer Science - Information Theory',
  'cs.lg': 'Computer Science - Machine Learning',
  'cs.lo': 'Computer Science - Logic in Computer Science',
  'cs.ma': 'Computer Science - Multiagent Systems',
  'cs.mm': 'Computer Science - Multimedia',
  'cs.ms': 'Computer Science - Mathematical Software',
  'cs.na': 'Computer Science - Numerical Analysis',
  'cs.ne': 'Computer Science - Neural and Evolutionary Computing',
  'cs.ni': 'Computer Science - Networking and Internet Architecture',
  'cs.oh': 'Computer Science - Other Computer Science',
  'cs.os': 'Computer Science - Operating Systems',
  'cs.pf': 'Computer Science - Performance',
  'cs.pl': 'Computer Science - Programming Languages',
  'cs.ro': 'Computer Science - Robotics',
  'cs.sc': 'Computer Science - Symbolic Computation',
  'cs.sd': 'Computer Science - Sound',
  'cs.se': 'Computer Science - Software Engineering',
  'cs.si': 'Computer Science - Social and Information Networks',
  'cs.sy': 'Computer Science - Systems and Control',

  // Statistics
  'stat.ml': 'Statistics - Machine Learning',
  'stat.ap': 'Statistics - Applied Statistics',
  'stat.co': 'Statistics - Computation',
  'stat.me': 'Statistics - Methodology',
  'stat.th': 'Statistics - Statistics Theory',

  // Mathematics
  'math.oc': 'Mathematics - Optimization and Control',
  'math.pr': 'Mathematics - Probability',
  'math.st': 'Mathematics - Statistical Theory',
  'math.na': 'Mathematics - Numerical Analysis',

  // Quantitative Biology
  'q-bio.bm': 'Quantitative Biology - Biomolecules',
  'q-bio.cb': 'Quantitative Biology - Cell Behavior',
  'q-bio.gn': 'Quantitative Biology - Genomics',
  'q-bio.mn': 'Quantitative Biology - Molecular Networks',
  'q-bio.nc': 'Quantitative Biology - Neurons and Cognition',
  'q-bio.qm': 'Quantitative Biology - Quantitative Methods',

  // Physics & Others
  'physics.comp-ph': 'Physics - Computational Physics',
  'physics.data-an': 'Physics - Data Analysis and Statistics',
  'econ.em': 'Economics - Econometrics',
};

// ── 2. Standard Scientific Acronyms (Preserve Full Upper Case) ─────────────────
const SCIENTIFIC_ACRONYMS = new Set([
  'AI', 'ML', 'NLP', 'CV', 'CNN', 'RNN', 'LSTM', 'GAN', 'BERT', 'LLM', 'LLMS',
  'COCO', 'YOLO', 'RESNET', 'VGG', 'SVM', 'RL', 'API', 'APIS', 'GPU', 'GPUS',
  'CPU', 'CPUS', 'TPU', 'TPUS', 'DNA', 'RNA', 'SGD', 'ADAM', 'RMSPROP', 'FTS',
  'RAG', 'OCR', 'DOI', 'URL', 'PDF', 'HTTP', 'HTTPS', 'HTML', 'XML', 'JSON',
  'DB', 'SQL', 'NOSQL', 'HCI', 'IOT', 'FPGA', 'ASIC', 'VAE', 'MCMC', 'ODE',
  'PDE', 'SOTA', 'BLEU', 'ROUGE', 'TF-IDF', 'GLUE', 'SUPERGLUE',
]);

// ── 3. Structural Document Noise Blacklist (Non-Keywords / Parsing Artifacts) ─
const NOISE_TAG_WORDS = new Set([
  'undefined', 'null', 'n/a', 'na', 'none', 'unknown', 'etc', 'various',
  'introduction', 'conclusion', 'background', 'paper', 'article',
  'study', 'approach', 'method', 'methods', 'results', 'discussion',
  'overview', 'experiment', 'experiments', 'analysis',
]);

// ── 4. String Sanitizers ───────────────────────────────────────────────────────

/** Fixes UTF-8 encoding corruption (Mojibake) common in academic PDF extraction */
export function fixMojibake(str: string): string {
  return str
    .replace(/â€“|â€”/g, '-')
    .replace(/â€™|â€˜/g, "'")
    .replace(/â€œ|â€ /g, '"')
    .replace(/\uFFFD/g, '')
    .replace(/\s+/g, ' ');
}

/** Strips Wikipedia/Wikidata disambiguation suffixes like "(psychology)", "(mathematics)" */
export function stripDisambiguationSuffix(str: string): string {
  return str.replace(/\s*\([^)]*(?:\)|$)/g, '').trim();
}

/** Strips common prefixes like "Keywords:", "Index Terms—", "#" */
export function stripTagPrefixes(str: string): string {
  return str
    .replace(/^(?:keywords?|index terms|categories|subject|topics?)[:—\-\s]+/i, '')
    .replace(/^#+/, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\.$/, '')
    .trim();
}

/** Converts string to intelligent Title Case preserving standard scientific acronyms */
export function toTitleCaseWithAcronyms(str: string): string {
  return str
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const upper = word.toUpperCase();
      if (SCIENTIFIC_ACRONYMS.has(upper)) {
        return upper;
      }
      // Handle hyphenated terms (e.g. Viola-Jones, Zero-Shot, Few-Shot)
      if (word.includes('-')) {
        return word
          .split('-')
          .map((part) => {
            const partUpper = part.toUpperCase();
            if (SCIENTIFIC_ACRONYMS.has(partUpper)) return partUpper;
            return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
          })
          .join('-');
      }
      // Minor words in lowercase if not first word
      const lower = word.toLowerCase();
      if (['and', 'or', 'of', 'in', 'on', 'for', 'with', 'at', 'by'].includes(lower)) {
        return lower;
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

/**
 * Cleans and formats a single tag.
 * Returns null if the tag is empty, invalid, or considered noise.
 */
export function cleanSingleTag(rawTag: string): string | null {
  if (!rawTag || typeof rawTag !== 'string') return null;

  let tag = fixMojibake(rawTag.trim());
  if (!tag) return null;

  // 1. Direct arXiv category mapping
  const lower = tag.toLowerCase();
  if (ARXIV_CATEGORY_MAP[lower]) {
    return ARXIV_CATEGORY_MAP[lower];
  }

  // 2. Direct noise blacklist check
  if (NOISE_TAG_WORDS.has(lower)) {
    return null;
  }

  // 3. Strip Wikipedia disambiguation FIRST before stripping edge quotes/brackets
  tag = stripDisambiguationSuffix(tag);
  if (NOISE_TAG_WORDS.has(tag.toLowerCase())) {
    return null;
  }

  // 4. Strip prefixes
  tag = stripTagPrefixes(tag);


  // 5. Length & sanity check: 2 - 60 chars, cannot be pure numbers
  if (tag.length < 2 || tag.length > 60) return null;
  if (/^\d+$/.test(tag)) return null;

  // 6. Generic single-word check after disambiguation removal
  if (NOISE_TAG_WORDS.has(tag.toLowerCase())) {
    return null;
  }

  // 7. Format with proper Title Case & Acronyms
  const formatted = toTitleCaseWithAcronyms(tag);
  // Ensure the very first letter is capitalized even if a minor word
  return formatted.charAt(0).toUpperCase() + formatted.slice(1);
}

/**
 * Comprehensive normalizer for a list of tags.
 * Handles:
 * - Splitting compound strings (separated by commas, semicolons, pipe, bullets)
 * - Removing noise, mojibake, disambiguation brackets
 * - Mapping taxonomy codes
 * - Deduplication (case-insensitive)
 */
export function normalizeAcademicTags(
  rawTags?: (string | { tag?: string; name?: string } | null | undefined)[] | null,
): string[] {
  if (!Array.isArray(rawTags) || rawTags.length === 0) return [];

  const seenLower = new Set<string>();
  const result: string[] = [];

  for (const item of rawTags) {
    if (!item) continue;
    const rawStr = typeof item === 'string' ? item : item.tag || item.name;
    if (!rawStr || typeof rawStr !== 'string') continue;

    // Split compound tags by comma, semicolon, newline, pipe, or bullet
    const parts = rawStr
      .split(/[,;\n\r|•·]/)
      .map((p) => p.trim())
      .filter(Boolean);

    for (const part of parts) {
      const cleaned = cleanSingleTag(part);
      if (!cleaned) continue;

      const lowerKey = cleaned.toLowerCase();
      if (!seenLower.has(lowerKey)) {
        seenLower.add(lowerKey);
        result.push(cleaned);
      }
    }
  }

  return result;
}


/**
 * Normalizes an array of raw tag strings or tag objects into a unique, trimmed,
 * clean, and standardized list of academic tags.
 */
export function normalizeTags(
  tags?: (TagInput | null | undefined)[] | null,
): string[] {
  return normalizeAcademicTags(tags as any);
}
