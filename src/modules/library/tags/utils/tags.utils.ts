import { TagInput } from '../types/tags.types';

/**
 * Academic Tag Normalizer
 * Self-hosted, zero-dependency academic taxonomy resolution, tag cleanup,
 * mojibake fixing, and casing standardization.
 */

// ── 1. arXiv Taxonomy to Zotero-Standard Human-Readable Academic Fields ─────────
export const ARXIV_CATEGORY_MAP: Record<string, string> = {
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
  'math.ag': 'Mathematics - Algebraic Geometry',
  'math.at': 'Mathematics - Algebraic Topology',
  'math.ap': 'Mathematics - Analysis of PDEs',
  'math.ca': 'Mathematics - Classical Analysis and ODEs',
  'math.co': 'Mathematics - Combinatorics',
  'math.ct': 'Mathematics - Category Theory',
  'math.cv': 'Mathematics - Complex Variables',
  'math.dg': 'Mathematics - Differential Geometry',
  'math.ds': 'Mathematics - Dynamical Systems',
  'math.fa': 'Mathematics - Functional Analysis',
  'math.gm': 'Mathematics - General Mathematics',
  'math.gn': 'Mathematics - General Topology',
  'math.gr': 'Mathematics - Group Theory',
  'math.gt': 'Mathematics - Geometric Topology',
  'math.ho': 'Mathematics - History and Overview',
  'math.it': 'Mathematics - Information Theory',
  'math.kt': 'Mathematics - K-Theory and Homology',
  'math.lo': 'Mathematics - Logic',
  'math.mg': 'Mathematics - Metric Geometry',
  'math.mp': 'Mathematics - Mathematical Physics',
  'math.na': 'Mathematics - Numerical Analysis',
  'math.nt': 'Mathematics - Number Theory',
  'math.oa': 'Mathematics - Operator Algebras',
  'math.oc': 'Mathematics - Optimization and Control',
  'math.pr': 'Mathematics - Probability',
  'math.qa': 'Mathematics - Quantum Algebra',
  'math.ra': 'Mathematics - Rings and Algebras',
  'math.rt': 'Mathematics - Representation Theory',
  'math.sg': 'Mathematics - Symplectic Geometry',
  'math.sp': 'Mathematics - Spectral Theory',
  'math.st': 'Mathematics - Statistical Theory',

  // Electrical Engineering and Systems Science
  'eess.as': 'Electrical Engineering and Systems Science - Audio and Speech Processing',
  'eess.iv': 'Electrical Engineering and Systems Science - Image and Video Processing',
  'eess.sp': 'Electrical Engineering and Systems Science - Signal Processing',
  'eess.sy': 'Electrical Engineering and Systems Science - Systems and Control',

  // Quantitative Biology
  'q-bio.bm': 'Quantitative Biology - Biomolecules',
  'q-bio.cb': 'Quantitative Biology - Cell Behavior',
  'q-bio.gn': 'Quantitative Biology - Genomics',
  'q-bio.mn': 'Quantitative Biology - Molecular Networks',
  'q-bio.nc': 'Quantitative Biology - Neurons and Cognition',
  'q-bio.ot': 'Quantitative Biology - Other Quantitative Biology',
  'q-bio.pe': 'Quantitative Biology - Populations and Evolution',
  'q-bio.qm': 'Quantitative Biology - Quantitative Methods',
  'q-bio.sc': 'Quantitative Biology - Subcellular Processes',
  'q-bio.to': 'Quantitative Biology - Tissues and Organs',

  // Quantitative Finance
  'q-fin.cp': 'Quantitative Finance - Computational Finance',
  'q-fin.ec': 'Quantitative Finance - Economics',
  'q-fin.gn': 'Quantitative Finance - General Finance',
  'q-fin.mf': 'Quantitative Finance - Mathematical Finance',
  'q-fin.pm': 'Quantitative Finance - Portfolio Management',
  'q-fin.pr': 'Quantitative Finance - Pricing of Securities',
  'q-fin.rm': 'Quantitative Finance - Risk Management',
  'q-fin.st': 'Quantitative Finance - Statistical Finance',
  'q-fin.tr': 'Quantitative Finance - Trading and Market Microstructure',

  // Nonlinear Sciences
  'nlin.ao': 'Nonlinear Sciences - Adaptation and Self-Organizing Systems',
  'nlin.cd': 'Nonlinear Sciences - Chaotic Dynamics',
  'nlin.cg': 'Nonlinear Sciences - Cellular Automata and Lattice Gases',
  'nlin.ps': 'Nonlinear Sciences - Pattern Formation and Solitons',
  'nlin.si': 'Nonlinear Sciences - Exactly Solvable and Solitable Nonlinear Systems',

  // Physics & Astrophysics
  'astro-ph': 'Astrophysics',
  'astro-ph.co': 'Astrophysics - Cosmology and Nongalactic Astrophysics',
  'astro-ph.ep': 'Astrophysics - Earth and Planetary Astrophysics',
  'astro-ph.ga': 'Astrophysics - Astrophysics of Galaxies',
  'astro-ph.he': 'Astrophysics - High Energy Astrophysical Phenomena',
  'astro-ph.im': 'Astrophysics - Instrumentation and Methods for Astrophysics',
  'astro-ph.sr': 'Astrophysics - Solar and Stellar Astrophysics',
  'cond-mat.dis-nn': 'Condensed Matter - Disordered Systems and Neural Networks',
  'cond-mat.mes-hall': 'Condensed Matter - Mesoscale and Nanoscale Physics',
  'cond-mat.mtrl-sci': 'Condensed Matter - Materials Science',
  'cond-mat.other': 'Condensed Matter - Other Condensed Matter',
  'cond-mat.quant-gas': 'Condensed Matter - Quantum Gases',
  'cond-mat.soft': 'Condensed Matter - Soft Condensed Matter',
  'cond-mat.stat-mech': 'Condensed Matter - Statistical Mechanics',
  'cond-mat.str-el': 'Condensed Matter - Strongly Correlated Electrons',
  'cond-mat.supr-con': 'Condensed Matter - Superconductivity',
  'gr-qc': 'General Relativity and Quantum Cosmology',
  'hep-ex': 'High Energy Physics - Experiment',
  'hep-lat': 'High Energy Physics - Lattice',
  'hep-ph': 'High Energy Physics - Phenomenology',
  'hep-th': 'High Energy Physics - Theory',
  'math-ph': 'Mathematical Physics',
  'nucl-ex': 'Nuclear Experiment',
  'nucl-th': 'Nuclear Theory',
  'quant-ph': 'Quantum Physics',
  'physics.acc-ph': 'Physics - Accelerator Physics',
  'physics.ao-ph': 'Physics - Atmospheric and Oceanic Physics',
  'physics.app-ph': 'Physics - Applied Physics',
  'physics.atm-clus': 'Physics - Atomic and Molecular Clusters',
  'physics.atom-ph': 'Physics - Atomic Physics',
  'physics.bio-ph': 'Physics - Biological Physics',
  'physics.chem-ph': 'Physics - Chemical Physics',
  'physics.class-ph': 'Physics - Classical Physics',
  'physics.comp-ph': 'Physics - Computational Physics',
  'physics.data-an': 'Physics - Data Analysis and Statistics',
  'physics.ed-ph': 'Physics - Physics Education',
  'physics.flu-dyn': 'Physics - Fluid Dynamics',
  'physics.gen-ph': 'Physics - General Physics',
  'physics.geo-ph': 'Physics - Geophysics',
  'physics.hist-ph': 'Physics - History and Philosophy of Physics',
  'physics.ins-det': 'Physics - Instrumentation and Detectors',
  'physics.med-ph': 'Physics - Medical Physics',
  'physics.optics': 'Physics - Optics',
  'physics.params-ph': 'Physics - Popular Physics',
  'physics.plasm-ph': 'Physics - Plasma Physics',
  'physics.pop-ph': 'Physics - Popular Physics',
  'physics.soc-ph': 'Physics - Physics and Society',
  'physics.space-ph': 'Physics - Space Physics',

  // Economics
  'econ.em': 'Economics - Econometrics',
  'econ.gn': 'Economics - General Economics',
  'econ.th': 'Economics - Theoretical Economics',
};

// ── 2. Standard Scientific Acronyms (Preserve Full Upper Case) ─────────────────
export const SCIENTIFIC_ACRONYMS = new Set([
  'AI',
  'ML',
  'NLP',
  'CV',
  'CNN',
  'RNN',
  'LSTM',
  'GAN',
  'BERT',
  'LLM',
  'LLMS',
  'COCO',
  'YOLO',
  'RESNET',
  'VGG',
  'SVM',
  'RL',
  'API',
  'APIS',
  'GPU',
  'GPUS',
  'CPU',
  'CPUS',
  'TPU',
  'TPUS',
  'DNA',
  'RNA',
  'SGD',
  'ADAM',
  'RMSPROP',
  'FTS',
  'RAG',
  'OCR',
  'DOI',
  'URL',
  'PDF',
  'HTTP',
  'HTTPS',
  'HTML',
  'XML',
  'JSON',
  'DB',
  'SQL',
  'NOSQL',
  'HCI',
  'IOT',
  'FPGA',
  'ASIC',
  'VAE',
  'MCMC',
  'ODE',
  'PDE',
  'SOTA',
  'BLEU',
  'ROUGE',
  'TF-IDF',
  'GLUE',
  'SUPERGLUE',
  'COVID',
  'COVID-19',
  'SARS',
  'COV',
  'CRISPR',
  'MRI',
  'FMRI',
  'CT',
  'EEG',
  'ECG',
  'PET',
]);

// ── 3. Structural Document Noise Blacklist (Non-Keywords / Parsing Artifacts) ─
export const NOISE_TAG_WORDS = new Set([
  // Placeholders / Empty / Null indicators
  'undefined',
  'null',
  'n/a',
  'na',
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

  // Publisher, copyright, repository noise
  'all rights reserved',
  'copyright',
  'open access',
  'creative commons',
  'springer',
  'elsevier',
  'ieee',
  'acm',
  'wiley',
  'nature',
  'science',
  'proceedings',
  'conference',
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
  'available online',
  'downloaded',
  'preprint',
  'manuscript',
  'author',
  'authors',
  'editor',
  'editors',
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
  // Only strip disambiguation at the END of a string that has preceding text
  return str.replace(/(?<=[\w\d])\s+\([^)]*\)$/g, '').trim();
}

/** Strips common prefixes and leading/trailing quotes, brackets, dots, ellipses (...) */
export function stripTagPrefixes(str: string): string {
  return str
    .replace(/<[^>]+>/g, '')
    .replace(/[{}]/g, '')
    .replace(
      /^(?:tags?|keywords?|index terms?|categor(?:y|ies)|subject(?: areas?)?|topics?|terms?|arxiv)[:—\-\s]+/i,
      '',
    )
    .replace(/^[#"''`([{<•·*—\-\s]+/, '')
    .replace(/^(?:\.{2,}|…)+/, '')
    .replace(/["''`)\]}>]+$/, '')
    .replace(/(?:\.{2,}|…|[.,;:—\-\s•·*])+$/, '')
    .trim();
}

/** Converts string to intelligent Title Case preserving standard scientific acronyms */
export function toTitleCaseWithAcronyms(str: string): string {
  const fullUpper = str.trim().toUpperCase();
  if (SCIENTIFIC_ACRONYMS.has(fullUpper)) {
    return fullUpper;
  }

  return str
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const upper = word.toUpperCase();
      if (SCIENTIFIC_ACRONYMS.has(upper)) {
        return upper;
      }
      // Preserve isolated dash in compounds or category separator " - "
      if (word === '-') {
        return '-';
      }
      // Handle hyphenated terms (e.g. Viola-Jones, Zero-Shot, Few-Shot, COVID-19)
      if (word.includes('-')) {
        const wordUpper = word.toUpperCase();
        if (SCIENTIFIC_ACRONYMS.has(wordUpper)) {
          return wordUpper;
        }
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
      if (
        ['and', 'or', 'of', 'in', 'on', 'for', 'with', 'at', 'by'].includes(
          lower,
        )
      ) {
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

  // 0. Strip XML/HTML tags and braces
  tag = tag.replace(/<[^>]+>/g, '').replace(/[{}]/g, '').trim();

  // 1. Strip Wikipedia disambiguation FIRST before edge quotes/brackets
  tag = stripDisambiguationSuffix(tag);

  // 2. Strip prefixes (tag:, tags:, category:, arxiv:), quotes, brackets, dots, ellipses
  tag = stripTagPrefixes(tag);
  if (!tag) return null;

  // 3. Direct arXiv category mapping (supports cs.cl, cs.CL, cs-cl, cs_cl, [cs.CL])
  const lower = tag.toLowerCase();
  if (ARXIV_CATEGORY_MAP[lower]) {
    return ARXIV_CATEGORY_MAP[lower];
  }
  const withDot = lower.replace(/[-_]/g, '.');
  if (ARXIV_CATEGORY_MAP[withDot]) {
    return ARXIV_CATEGORY_MAP[withDot];
  }

  // 4. Direct noise blacklist check
  if (NOISE_TAG_WORDS.has(lower)) {
    return null;
  }

  // 5. Sanity & garbage checks:
  // Must be 2 - 60 chars
  if (tag.length < 2 || tag.length > 60) return null;

  // Must contain at least one alphanumeric character
  if (!/[a-zA-Z0-9\u00C0-\u024F\u1EA0-\u1EF9]/.test(tag)) return null;

  // Cannot be pure numbers
  if (/^\d+$/.test(tag)) return null;

  // Cannot be page numbers or volume indicators (e.g. "pp. 12-15", "vol. 4", "no. 2")
  if (/^(?:p|pp|vol|no|v|issue)\.?\s*\d+(?:[-–—]\d+)?$/i.test(tag)) return null;

  // Cannot be a pure year or number range (e.g. "2020-2021", "10-25")
  if (/^\d{1,4}[-–—]\d{1,4}$/.test(tag)) return null;

  // Cannot be a URL, email, or DOI
  if (
    /^https?:\/\//i.test(tag) ||
    /^www\./i.test(tag) ||
    /@/.test(tag) ||
    /^10\.\d{4,9}\//i.test(tag)
  ) {
    return null;
  }

  // Cannot be an ellipsis or dots sequence
  if (/^(\.{2,}|…)+$/.test(tag)) return null;

  // 6. Generic noise check after prefix removal
  if (NOISE_TAG_WORDS.has(tag.toLowerCase())) {
    return null;
  }

  // 7. Format with proper Title Case & Acronyms
  const formatted = toTitleCaseWithAcronyms(tag);
  // Ensure the very first letter is capitalized even if a minor word
  let result = formatted.charAt(0).toUpperCase() + formatted.slice(1);

  // Strip any trailing ellipsis or punctuation that might have survived TitleCase
  result = result.replace(/(?:\.{2,}|…|[.,;:—\-\s])+$/, '').trim();

  return result.length >= 2 ? result : null;
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
  rawTags?:
    (string | { tag?: string; name?: string } | null | undefined)[] | null,
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
  return normalizeAcademicTags(tags);
}

// ── Canonical Casing for arXiv Category Codes ──────────────────────────────
export const CANONICAL_ARXIV_CATEGORIES: Record<string, string> = {
  // Computer Science
  'cs.ai': 'cs.AI',
  'cs.ar': 'cs.AR',
  'cs.cc': 'cs.CC',
  'cs.ce': 'cs.CE',
  'cs.cg': 'cs.CG',
  'cs.cl': 'cs.CL',
  'cs.cr': 'cs.CR',
  'cs.cv': 'cs.CV',
  'cs.cy': 'cs.CY',
  'cs.db': 'cs.DB',
  'cs.dc': 'cs.DC',
  'cs.dl': 'cs.DL',
  'cs.dm': 'cs.DM',
  'cs.ds': 'cs.DS',
  'cs.et': 'cs.ET',
  'cs.fl': 'cs.FL',
  'cs.gl': 'cs.GL',
  'cs.gr': 'cs.GR',
  'cs.gt': 'cs.GT',
  'cs.hc': 'cs.HC',
  'cs.ir': 'cs.IR',
  'cs.it': 'cs.IT',
  'cs.lg': 'cs.LG',
  'cs.lo': 'cs.LO',
  'cs.ma': 'cs.MA',
  'cs.mm': 'cs.MM',
  'cs.ms': 'cs.MS',
  'cs.na': 'cs.NA',
  'cs.ne': 'cs.NE',
  'cs.ni': 'cs.NI',
  'cs.oh': 'cs.OH',
  'cs.os': 'cs.OS',
  'cs.pf': 'cs.PF',
  'cs.pl': 'cs.PL',
  'cs.ro': 'cs.RO',
  'cs.sc': 'cs.SC',
  'cs.sd': 'cs.SD',
  'cs.se': 'cs.SE',
  'cs.si': 'cs.SI',
  'cs.sy': 'cs.SY',

  // Statistics
  'stat.ml': 'stat.ML',
  'stat.ap': 'stat.AP',
  'stat.co': 'stat.CO',
  'stat.me': 'stat.ME',
  'stat.th': 'stat.TH',

  // Mathematics
  'math.oc': 'math.OC',
  'math.pr': 'math.PR',
  'math.st': 'math.ST',
  'math.na': 'math.NA',
  'math.ag': 'math.AG',
  'math.at': 'math.AT',
  'math.ap': 'math.AP',
  'math.ca': 'math.CA',
  'math.co': 'math.CO',
  'math.ds': 'math.DS',
  'math.fa': 'math.FA',
  'math.gm': 'math.GM',
  'math.gn': 'math.GN',
  'math.gr': 'math.GR',
  'math.gt': 'math.GT',
  'math.lo': 'math.LO',
  'math.mg': 'math.MG',
  'math.mp': 'math.MP',
  'math.nt': 'math.NT',
  'math.oa': 'math.OA',
  'math.qa': 'math.QA',
  'math.ra': 'math.RA',
  'math.rt': 'math.RT',
  'math.sg': 'math.SG',
  'math.sp': 'math.SP',

  // Quantitative Biology
  'q-bio.bm': 'q-bio.BM',
  'q-bio.cb': 'q-bio.CB',
  'q-bio.gn': 'q-bio.GN',
  'q-bio.mn': 'q-bio.MN',
  'q-bio.nc': 'q-bio.NC',
  'q-bio.ot': 'q-bio.OT',
  'q-bio.pe': 'q-bio.PE',
  'q-bio.qm': 'q-bio.QM',
  'q-bio.sc': 'q-bio.SC',
  'q-bio.to': 'q-bio.TO',

  // Quantitative Finance
  'q-fin.cp': 'q-fin.CP',
  'q-fin.ec': 'q-fin.EC',
  'q-fin.gn': 'q-fin.GN',
  'q-fin.mf': 'q-fin.MF',
  'q-fin.pm': 'q-fin.PM',
  'q-fin.pr': 'q-fin.PR',
  'q-fin.rm': 'q-fin.RM',
  'q-fin.st': 'q-fin.ST',
  'q-fin.tr': 'q-fin.TR',

  // Physics & Others
  'physics.comp-ph': 'physics.comp-ph',
  'physics.data-an': 'physics.data-an',
  'physics.soc-ph': 'physics.soc-ph',
  'quant-ph': 'quant-ph',
  'gr-qc': 'gr-qc',
  'hep-th': 'hep-th',
  'hep-ph': 'hep-ph',
  'hep-lat': 'hep-lat',
  'hep-ex': 'hep-ex',
  'cond-mat.mes-hall': 'cond-mat.mes-hall',
  'cond-mat.mtrl-sci': 'cond-mat.mtrl-sci',
  'cond-mat.str-el': 'cond-mat.str-el',
  'cond-mat.supr-con': 'cond-mat.supr-con',
  'astro-ph.co': 'astro-ph.CO',
  'astro-ph.ep': 'astro-ph.EP',
  'astro-ph.ga': 'astro-ph.GA',
  'astro-ph.he': 'astro-ph.HE',
  'astro-ph.im': 'astro-ph.IM',
  'astro-ph.sr': 'astro-ph.SR',
  // Electrical Engineering and Systems Science
  'eess.as': 'eess.AS',
  'eess.iv': 'eess.IV',
  'eess.sp': 'eess.SP',
  'eess.sy': 'eess.SY',

  // Nonlinear Sciences
  'nlin.ao': 'nlin.AO',
  'nlin.cd': 'nlin.CD',
  'nlin.cg': 'nlin.CG',
  'nlin.ps': 'nlin.PS',
  'nlin.si': 'nlin.SI',

  // Economics
  'econ.em': 'econ.EM',
  'econ.gn': 'econ.GN',
  'econ.th': 'econ.TH',
};

// ── Landmark Classic arXiv Benchmark Papers ──────────────────────────────
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
 * Resolves the canonical arXiv primary category code (e.g. "cs.LG", "stat.ML", "math.PR")
 * for native Zotero Extra field formatting: arXiv: <id> [<primaryCategory>]
 */
export function resolveCanonicalArxivCategory(
  arxivId?: string | null,
  tags?: any[],
  extraFields?: any,
  item?: any,
): string | undefined {
  if (typeof extraFields?.primaryCategory === 'string' && extraFields.primaryCategory.trim()) {
    const raw = extraFields.primaryCategory.trim();
    return CANONICAL_ARXIV_CATEGORIES[raw.toLowerCase()] || raw;
  }
  if (typeof extraFields?.category === 'string' && extraFields.category.trim()) {
    const raw = extraFields.category.trim();
    return CANONICAL_ARXIV_CATEGORIES[raw.toLowerCase()] || raw;
  }
  if (typeof item?.primaryCategory === 'string' && item.primaryCategory.trim()) {
    const raw = item.primaryCategory.trim();
    return CANONICAL_ARXIV_CATEGORIES[raw.toLowerCase()] || raw;
  }

  const candidates: string[] = [];
  if (Array.isArray(tags)) {
    for (const t of tags) {
      if (t) candidates.push(typeof t === 'object' && t.name ? String(t.name) : String(t));
    }
  }
  if (Array.isArray(item?.keywords)) {
    for (const k of item.keywords) {
      if (k) candidates.push(typeof k === 'object' && k.name ? String(k.name) : String(k));
    }
  }

  // 1. Direct code match
  for (const c of candidates) {
    const lower = c.trim().toLowerCase();
    if (CANONICAL_ARXIV_CATEGORIES[lower]) {
      return CANONICAL_ARXIV_CATEGORIES[lower];
    }
    if (
      /^[a-z\-]+(?:\.[a-z\-]+)?$/i.test(c.trim()) &&
      !['pdf', 'oa', 'openaccess', 'arxiv', 'preprint', 'paper', 'article'].includes(lower)
    ) {
      return CANONICAL_ARXIV_CATEGORIES[lower] || c.trim();
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
    if (/machine\s*learning|reinforcement\s*learning/i.test(lower)) return 'cs.LG';
    if (/computer\s*vision/i.test(lower)) return 'cs.CV';
    if (/natural\s*language|computation\s*and\s*language/i.test(lower)) return 'cs.CL';
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
    if (/reinforcement\s*learning|deep\s*q-network|atari/i.test(title) || /deep\s*q-network|atari/i.test(abs)) {
      return 'cs.LG';
    }
    if (/machine\s*learning/i.test(title)) return 'cs.LG';
    if (/generative\s*adversarial\s*network/i.test(title)) return 'stat.ML';
    if (/computer\s*vision|object\s*detection|segmentation/i.test(title)) return 'cs.CV';
    if (/language\s*model|transformer|bert|gpt/i.test(title)) return 'cs.CL';
  }

  return undefined;
}

