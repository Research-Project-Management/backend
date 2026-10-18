import {
  CreatorType,
  CreatorInput,
  ParsedCreator,
} from '@/modules/library/core/types/bibliographic.types';
import {
  stripXmlAndHtmlTags,
  decodeHtmlEntities,
  stripLatexBraces,
} from './academic-text.domain';

export type { ParsedCreator };

/**
 * Whole-word keywords that mark a creator string as an organization
 * (Zotero single-field creator, fieldMode = 1). Deliberately excludes short
 * tokens that collide with person names (e.g. "who", "mit", "meta").
 */
export const INSTITUTION_KEYWORDS = [
  'university',
  'universities',
  'universität',
  'université',
  'universidad',
  'universidade',
  'università',
  'institute',
  'institutes',
  'institution',
  'institutions',
  'consortium',
  'consortia',
  'collaboration',
  'collaborations',
  'committee',
  'committees',
  'organization',
  'organizations',
  'organisation',
  'organisations',
  'association',
  'associations',
  'society',
  'societies',
  'foundation',
  'group',
  'groups',
  'team',
  'council',
  'agency',
  'agencies',
  'department',
  'departments',
  'ministry',
  'laboratory',
  'laboratories',
  'center',
  'centers',
  'centre',
  'centres',
  'network',
  'initiative',
  'working party',
  'investigators',
  'commission',
  'corporation',
  'hospital',
  'hospitals',
  'inc',
  'llc',
  'ltd',
  'openai',
  'deepmind',
  'anthropic',
  'google',
  'microsoft',
  'cern',
  'nasa',
  'ieee',
];

const INSTITUTION_REGEX = new RegExp(
  `(?:^|[^\\p{L}\\p{N}])(?:${INSTITUTION_KEYWORDS.map((kw) =>
    kw.replace(/\s+/g, '\\s+'),
  ).join('|')})(?=$|[^\\p{L}\\p{N}])`,
  'iu',
);

/**
 * Returns true when the (already cleaned) creator string looks like an
 * organization rather than a person (whole-word keyword match).
 */
export function isInstitutionName(name?: string | null): boolean {
  if (!name || typeof name !== 'string') return false;
  return INSTITUTION_REGEX.test(name);
}

/** Lowercase name particles (only matched when written in lowercase). */
const PREFIX_PARTICLES = new Set([
  'von',
  'van',
  'vander',
  'vanden',
  'de',
  'del',
  'della',
  'der',
  'den',
  'des',
  'da',
  'das',
  'do',
  'dos',
  'di',
  'du',
  'la',
  'le',
  'las',
  'los',
  'ter',
  'ten',
  'zu',
  'al',
  'el',
  'bin',
  'ibn',
  'st.',
  'st',
  'saint',
  'sainte',
]);

const GENERATIONAL_SUFFIX_REGEX = /^(?:Jr\.?|Sr\.?|II|III|IV|V|Esq\.?)$/i;

/** Surname beginning with a name particle, e.g. "van der Berg", "De Silva", "La Fontaine". */
const PARTICLE_SURNAME_REGEX =
  /^(?:(?:von|van|vander|vanden|de|del|della|der|den|des|da|das|do|dos|di|du|la|le|las|los|ter|ten|zu|al|el|bin|ibn|st\.?|saint|sainte|Von|Van|Vander|Vanden|De|Del|Della|Der|Den|Des|Da|Das|Do|Dos|Di|Du|La|Le|Las|Los|Ter|Ten|Zu|Al|El|Bin|Ibn|St\.?|Saint|Sainte)\s+)+\S/;

/**
 * Detects Vancouver / Medline style names: "Smith JA", "van der Berg AB",
 * "O'Neil P". The trailing token must be 1-3 uppercase initials without dots
 * and every surname token must be a lowercase particle or a capitalized word
 * containing at least one lowercase letter.
 */
export function isVancouverName(raw?: string | null): boolean {
  if (!raw || typeof raw !== 'string') return false;
  const tokens = raw.trim().split(/\s+/);
  if (tokens.length < 2) return false;
  const initials = tokens[tokens.length - 1];
  if (!/^[A-Z]{1,3}$/.test(initials)) return false;
  if (/^(?:II|III|IV)$/.test(initials)) return false;
  const surname = tokens.slice(0, -1);
  let hasCore = false;
  for (const t of surname) {
    if (PREFIX_PARTICLES.has(t)) continue;
    if (!/^\p{Lu}[\p{L}'’-]*$/u.test(t) || !/\p{Ll}/u.test(t)) return false;
    hasCore = true;
  }
  return hasCore;
}

/**
 * Vietnamese Specific Diacritics Regex (NFC normalized).
 * Covers all tone marks and vowel variations unique to the Vietnamese alphabet.
 */
export const VIETNAMESE_DIACRITICS_REGEX =
  /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđÀÁẢÃẠĂẰẮẲẴẶÂẦẤẨẪẬÈÉẺẼẸÊỀẾỂỄỆÌÍỈĨỊÒÓỎÕỌÔỒỐỔỖỘƠỜỚỞỠỢÙÚỦŨỤƯỪỨỬỮỰỲÝỶỸỴĐ]/u;

/**
 * Returns true if the text contains Vietnamese-specific accented characters.
 */
export function hasVietnameseDiacritics(text?: string | null): boolean {
  if (!text || typeof text !== 'string') return false;
  return VIETNAMESE_DIACRITICS_REGEX.test(text.normalize('NFC'));
}

/**
 * Common Vietnamese family names (surnames), including both diacritic
 * and common unaccented ASCII representations in English publications.
 */
export const VIETNAMESE_FAMILY_NAMES = new Set([
  // Accented forms
  'nguyễn',
  'trần',
  'lê',
  'phạm',
  'hoàng',
  'huỳnh',
  'phan',
  'vũ',
  'võ',
  'đặng',
  'bùi',
  'đỗ',
  'hồ',
  'ngô',
  'dương',
  'lý',
  'đinh',
  'đoàn',
  'lâm',
  'trịnh',
  'mai',
  'đào',
  'cao',
  'hà',
  'lưu',
  'lương',
  'thái',
  'phùng',
  'tô',
  'vương',
  'tạ',
  'tống',
  'quách',
  'nông',
  'diệp',
  'triệu',
  'tiêu',
  'khổng',
  'nghiêm',
  'la',
  'tăng',
  'trương',
  'chu',
  'châu',
  'tôn',
  'vi',
  'lục',
  'ma',
  'bành',
  'cù',
  'cấn',
  'thạch',
  'bạch',
  'sầm',
  'lại',
  'hứa',
  'kiều',
  'mạc',
  'cáp',
  'thân',
  'tào',
  'nhan',
  'mã',
  'chử',
  'doãn',
  'ân',
  'bàng',
  'quản',
  'đậu',
  'phí',
  // Unaccented equivalents
  'nguyen',
  'tran',
  'le',
  'pham',
  'hoang',
  'huynh',
  'phan',
  'vu',
  'vo',
  'dang',
  'bui',
  'do',
  'ho',
  'ngo',
  'duong',
  'ly',
  'dinh',
  'doan',
  'lam',
  'trinh',
  'mai',
  'dao',
  'cao',
  'ha',
  'luu',
  'luong',
  'thai',
  'phung',
  'to',
  'vuong',
  'ta',
  'tong',
  'quach',
  'nong',
  'diep',
  'trieu',
  'tieu',
  'khong',
  'nghiem',
  'tang',
  'truong',
  'chu',
  'chau',
  'ton',
  'luc',
  'banh',
  'cu',
  'can',
  'thach',
  'bach',
  'sam',
  'lai',
  'hua',
  'kieu',
  'mac',
  'cap',
  'than',
  'tao',
  'quan',
  'dau',
  'phi',
]);

/**
 * Common Compound Vietnamese Surnames (Họ kép), accented and unaccented.
 */
export const VIETNAMESE_COMPOUND_SURNAMES = new Set([
  'nguyễn phúc',
  'nguyễn phước',
  'nguyễn đình',
  'nguyễn hữu',
  'nguyễn huy',
  'nguyễn bá',
  'nguyễn đức',
  'nguyễn cảnh',
  'nguyễn khắc',
  'nguyễn khoa',
  'nguyễn trần',
  'trần hưng',
  'trần đắc',
  'trần đình',
  'phan huy',
  'phan bội',
  'ngô thì',
  'ngô đình',
  'hoàng văn',
  'nguyen phuc',
  'nguyen phuoc',
  'nguyen dinh',
  'nguyen huu',
  'nguyen huy',
  'nguyen ba',
  'nguyen duc',
  'nguyen canh',
  'nguyen khac',
  'nguyen khoa',
  'nguyen tran',
  'tran hung',
  'tran dac',
  'tran dinh',
  'phan huy',
  'phan boi',
  'ngo thi',
  'ngo dinh',
  'hoang van',
]);

/**
 * Precompiled regex matching leading Vietnamese surnames (accented or unaccented).
 */
export const VIETNAMESE_SURNAMES_PREFIX_REGEX =
  /^(nguy[eễ]n|tr[aầ]n|l[eê]|ph[aạ]m|ho[aà]ng|hu[yỳ]nh|phan|v[uũ]|v[oõ]|đ[aặ]ng|b[uù]i|đ[oỗ]|h[oồ]|ng[oô]|d[uư][oơ]ng|l[yý]|đinh|đo[aà]n|l[aâ]m|tr[iị]nh|mai|đ[aà]o|cao|h[aà]|l[uư]u|l[uư][oơ]ng|th[aá]i|t[aạ]|ph[uù]ng|t[oô]|v[uư][oơ]ng|chu|ch[aâ]u|t[oố]ng|qu[aá]ch|tri[eệ]u|nghi[eê]m|h[uứ]a|kh[oổ]ng|di[eệ]p|nhan|t[aă]ng|th[aạ]ch|ti[eê]u|l[uụ]c|m[aã]|ch[uử]|ki[eề]u|do[aã]n|c[uù]|b[aạ]ch|[aâ]n|b[aà]ng|tr[uư][oơ]ng|t[oô]n|qu[aả]n|đ[aậ]u|n[oô]ng|l[aạ]i|ph[ií]|la)(\s|$)/i;

/**
 * Common Vietnamese middle names / particles that help identify Vietnamese naming structures.
 */
export const VIETNAMESE_MIDDLE_NAMES = new Set([
  'văn',
  'thị',
  'hữu',
  'đình',
  'đức',
  'ngọc',
  'xuân',
  'thanh',
  'quang',
  'trọng',
  'minh',
  'hoàng',
  'anh',
  'hải',
  'quốc',
  'công',
  'kim',
  'bảo',
  'thu',
  'phương',
  'hồng',
  'thùy',
  'thảo',
  'mạnh',
  'tiến',
  'đắc',
  'tuấn',
  'hùng',
  'bá',
  'chí',
  // Unaccented
  'van',
  'thi',
  'huu',
  'dinh',
  'duc',
  'ngoc',
  'xuan',
  'thanh',
  'quang',
  'trong',
  'minh',
  'hoang',
  'anh',
  'hai',
  'quoc',
  'cong',
  'kim',
  'bao',
  'thu',
  'phuong',
  'hong',
  'thuy',
  'thao',
  'manh',
  'tien',
  'dac',
  'tuan',
  'hung',
  'ba',
  'chi',
]);

/**
 * Detects whether an author string is a Vietnamese name in traditional order (Family Name First).
 * e.g., "Nguyễn Văn An", "Tran Thi Mai", "Võ Nguyên Giáp".
 */
export function isVietnameseName(raw?: string | null): boolean {
  if (!raw || typeof raw !== 'string') return false;
  const normalized = raw.trim().normalize('NFC');
  if (normalized.includes(',')) return false;

  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 5) return false;

  const firstLower = tokens[0].toLowerCase();
  const startsWithVnFamily = VIETNAMESE_FAMILY_NAMES.has(firstLower);
  if (!startsWithVnFamily) return false;

  // If the name has Vietnamese diacritics, it's definitively Vietnamese
  if (hasVietnameseDiacritics(normalized)) {
    return true;
  }

  // If unaccented, guard against European names sharing short tokens (e.g. "Le Caille", "May Do")
  if (['le', 'mai', 'ha', 'do', 'la', 'to'].includes(firstLower)) {
    if (
      tokens.length >= 3 &&
      VIETNAMESE_MIDDLE_NAMES.has(tokens[1].toLowerCase())
    ) {
      return true;
    }
    if (
      tokens.length === 2 &&
      VIETNAMESE_MIDDLE_NAMES.has(tokens[1].toLowerCase())
    ) {
      return true;
    }
    return false;
  }

  // Unequivocal Vietnamese surnames (Nguyen, Tran, Pham, Dang, Bui, Huynh, Doan, Trinh, Duong...)
  const isPlausibleVnSyllable = (tok: string) =>
    /^[A-Za-z]{2,8}$/.test(tok) && !/[bcdfghjklmnpqrstvwxyz]{3,}/i.test(tok);

  return tokens.every(isPlausibleVnSyllable);
}

export const NOISE_AUTHOR_WORDS = new Set([
  'abstract',
  'introduction',
  'indexterms',
  'keywords',
  'keyword',
  'references',
  'reference',
  'bibliography',
  'contents',
  'tableofcontents',
  'acknowledgments',
  'acknowledgements',
  'correspondence',
  'correspondingauthor',
  'allrightsreserved',
  'copyright',
  'unknown',
  'none',
  'na',
  'nil',
  'etal',
  'others',
  'andothers',
  'visualgeometrygroup',
]);

/**
 * Validates if an extracted author name token is actually section noise, OCR artifact,
 * or academic affiliation header rather than a genuine author name.
 */
export function isNoiseAuthorName(raw?: string | null): boolean {
  if (!raw || typeof raw !== 'string') return true;
  const trimmed = raw.trim();
  if (!trimmed) return true;

  // Single non-word character or too short non-alphabetic
  if (trimmed.length <= 1 && !/[a-zA-Z]/.test(trimmed)) return true;

  // Collapse non-alpha characters to match against known noise blacklist
  // Handles letter-spaced headers: "A B S T R A C T", "A BSTRACT", "I N T R O D U C T I O N"
  const collapsed = trimmed.toLowerCase().replace(/[^a-z]/g, '');
  if (NOISE_AUTHOR_WORDS.has(collapsed)) return true;

  const lower = trimmed.toLowerCase();

  // Academic affiliations/departments mistakenly extracted as author names
  if (
    /^(?:department|faculty|school|division|college)\s+of\s+/i.test(lower) ||
    /^(?:lab|laboratory)\s+of\s+/i.test(lower) ||
    /^(?:centre|center)\s+for\s+/i.test(lower) ||
    /^(?:institute|university)\s+of\s+[a-z\s]+,\s*(?:department|faculty|school|division)/i.test(
      lower,
    )
  ) {
    return true;
  }

  // Reject emails or URLs mistakenly passed as author names
  if (/@/.test(trimmed) || /^https?:\/\//i.test(trimmed)) {
    return true;
  }

  // Submission, acceptance, revision, publication, or editor metadata
  if (
    /^(?:received|accepted|revised|published|submitted|editor|edited\s+by)\b/i.test(
      lower,
    )
  ) {
    return true;
  }
  if (/:/.test(trimmed)) {
    return true;
  }

  // Country and location tokens mistakenly parsed as author names
  if (
    /^(?:usa|uk|u\.s\.a\.?|japan|germany|france|china|russia|canada|australia|italy|spain|brazil|india)$/i.test(
      lower,
    )
  ) {
    return true;
  }
  // Standalone US state postal abbreviations
  if (
    /^(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)$/.test(
      trimmed,
    )
  ) {
    return true;
  }
  // Specific cities/regions commonly in address blocks
  if (
    /^(?:rochester|saclay|parietal|neurospin|boulder|cambridge|oxford|stanford|berkeley|zurich|heidelberg)$/i.test(
      lower,
    )
  ) {
    return true;
  }

  // Clinical / Medical / Imaging department or hospital terms
  if (
    /\b(?:hospital|clinic|infirmary|imaging|health\s+system)\b/i.test(lower)
  ) {
    return true;
  }

  return false;
}

/**
 * Strips OCR junk, footnote markers, email addresses, affiliations,
 * and academic titles from a single author string token.
 */
export function cleanAuthorName(raw?: string | null): string {
  if (!raw || typeof raw !== 'string') return '';

  let cleaned = stripXmlAndHtmlTags(raw);
  cleaned = decodeHtmlEntities(cleaned);
  cleaned = stripLatexBraces(cleaned);
  cleaned = cleaned.trim().normalize('NFC');

  // Strip emails: e.g. <user@domain.com> or user@domain.com
  cleaned = cleaned.replace(/<[^>]+@[^>]+>/g, ' ');
  cleaned = cleaned.replace(
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    ' ',
  );

  // Strip leading list numbering, bullets, or prefix: e.g. "1. ", "[1] ", "- ", "By: "
  cleaned = cleaned.replace(
    /^(?:(?:\[?\d+\]?[\.\)]?|[-•*])\s+|(?:by|author|authors):\s*)/i,
    '',
  );

  // Strip parenthetical roles/annotations: e.g. "(corresponding author)", "(equal contribution)", "(author)"
  cleaned = cleaned.replace(
    /\s*\((?:corresponding(?:\s*author)?|equal\s*contribution|author|lead\s*author|co-author|presenter|speaker|advisor|mentor|first\s*author)[^)]*\)/gi,
    '',
  );

  // Strip leading honorifics / academic titles: e.g. "Prof. Dr.", "Prof.", "Dr.", "Mr.", "Mrs.", "Ms."
  cleaned = cleaned.replace(
    /^(?:(?:Prof(?:essor)?|Dr|Doctor|Mr|Mrs|Ms)\.?\s+)+/i,
    '',
  );

  // Strip trailing comma-delimited professional degrees / fellowships:
  // e.g. "John Smith, PhD", "Smith, J. A., MD". Only stripped when the text
  // before the comma already contains a full name (space or comma), so that
  // inverted initials like "Wong, M.D." are NOT mistaken for a degree.
  // Generational suffixes (Jr., Sr., III) are kept.
  const TRAILING_DEGREE_REGEX =
    /,\s*(?:Ph\.?\s?D\.?|PHD|M\.?D\.?|M\.?Sc\.?|MSc|M\.?S\.?|B\.?Sc\.?|BSc|B\.?S\.?|MBA|MPH|D\.?Phil\.?|DPhil|FRS|FRSE|FIEEE|OBE|CBE)\s*$/;
  for (let guard = 0; guard < 4; guard++) {
    const m = cleaned.match(TRAILING_DEGREE_REGEX);
    if (!m || m.index === undefined) break;
    const prefix = cleaned.slice(0, m.index).trim();
    if (!/[\s,]/.test(prefix)) break;
    cleaned = prefix;
  }

  // Strip trailing footnote markers, superscripts, and affiliation numbers:
  // e.g. "1,2*", "*", "1", "†", "‡", "§", "1*", "*1", "∗", "⋆"
  cleaned = cleaned.replace(
    /(?:[\s,]*[*∗⋆†‡§¶^#~]+[\s,]*\d*|[\s,]*\d+[*∗⋆†‡§¶^#~]*)+$/u,
    '',
  );

  // Strip leading footnote markers if present
  cleaned = cleaned.replace(/^[*∗⋆†‡§¶^#~]+\s*/u, '');

  // Strip leftover footnote characters if any remain attached to words
  cleaned = cleaned.replace(/[*∗⋆†‡§¶^#~]+/gu, ' ');

  // Normalize excessive internal whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  // Remove trailing comma or semicolon if leftover
  cleaned = cleaned.replace(/[,;]+$/, '').trim();

  // Strip leading non-letter non-number punctuation (e.g. "˙ Ilhan Polat" -> "Ilhan Polat")
  cleaned = cleaned.replace(/^[^\p{L}\p{N}]+/u, '').trim();

  if (isNoiseAuthorName(cleaned)) {
    return '';
  }

  return cleaned;
}

/**
 * Splits a composite string of authors separated by ';', ' and ', ' & ', or commas.
 * Handles both "LastName, FirstName" pairs and forward names without mangling.
 */
export function splitAuthorString(input: string): string[] {
  if (!input || !input.trim()) return [];
  const trimmed = input.trim();
  const lines = trimmed
    .split(/\r?\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const result: string[] = [];

  for (const line of lines) {
    // 1. Semicolons are unequivocal delimiters in academic metadata
    if (line.includes(';')) {
      const parts = line
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const p of parts) {
        result.push(...splitAuthorString(p));
      }
      continue;
    }

    // 2. "and" / "&" conjunctions (e.g. "A, B, and C" or "A and B" or "A & B")
    //    Organizations ("Bill & Melinda Gates Foundation") are never split.
    if (
      (/\s+and\s+/i.test(line) || /\s+&\s+/.test(line)) &&
      !(isInstitutionName(line) && !line.includes(','))
    ) {
      const parts = line
        .split(/(?:,\s*(?:and|&)\s*|\s+(?:and|&)\s+)/i)
        .map((s) => s.trim())
        .filter(Boolean);
      for (const p of parts) {
        result.push(...splitAuthorString(p));
      }
      continue;
    }

    // 3. Comma-separated lists
    if (line.includes(',')) {
      const rawTokens = line
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (rawTokens.length <= 1) {
        result.push(line.trim());
        continue;
      }

      // Vancouver / Medline lists: "Smith JA, Jones B, van der Berg AB"
      if (rawTokens.every((t) => isVancouverName(t))) {
        result.push(...rawTokens);
        continue;
      }

      if (rawTokens.length === 2) {
        // Disambiguate: Is it "LastName, FirstName" (1 author) OR "FirstName1 LastName1, FirstName2 LastName2" (2 authors)?
        const firstHasSpace =
          rawTokens[0].includes(' ') &&
          !PARTICLE_SURNAME_REGEX.test(rawTokens[0]);
        const secondHasSpace = rawTokens[1].includes(' ');
        const isSuffix = GENERATIONAL_SUFFIX_REGEX.test(rawTokens[1]);

        if (isSuffix) {
          // e.g. "Martin Luther King, Jr." -> single author
          result.push(line.trim());
        } else if (firstHasSpace && secondHasSpace) {
          // e.g. "Karen Simonyan, Andrew Zisserman" -> two authors!
          result.push(rawTokens[0], rawTokens[1]);
        } else {
          // e.g. "Simonyan, Karen" or "Knuth, Donald E." -> single inverted author
          result.push(line.trim());
        }
        continue;
      }

      if (rawTokens.length === 3) {
        if (
          GENERATIONAL_SUFFIX_REGEX.test(rawTokens[1]) ||
          GENERATIONAL_SUFFIX_REGEX.test(rawTokens[2])
        ) {
          // BibTeX / RIS single author with suffix: "Gates, Jr., Bill" or "Gates, Bill, Jr."
          result.push(line.trim());
          continue;
        }
      }

      // rawTokens.length >= 3:
      // Check if rawTokens are alternating [Surname, First/Initial, Surname, First/Initial, ...]
      const isEven = rawTokens.length % 2 === 0;
      let looksLikeInvertedPairs = isEven;

      if (isEven) {
        for (let i = 0; i < rawTokens.length; i += 2) {
          const surname = rawTokens[i];
          if (surname.includes(' ') && !PARTICLE_SURNAME_REGEX.test(surname)) {
            looksLikeInvertedPairs = false;
            break;
          }
        }
      }

      if (looksLikeInvertedPairs) {
        for (let i = 0; i < rawTokens.length; i += 2) {
          result.push(`${rawTokens[i]}, ${rawTokens[i + 1]}`);
        }
      } else {
        // Forward author list: each token is an author
        for (const t of rawTokens) {
          result.push(t);
        }
      }
      continue;
    }

    // 4. Footnote-delimited author lists: e.g. "Author 1 ∗ Author 2 ∗ Author 3"
    // Many preprints and conferences (NeurIPS, ICML, etc.) place all authors on a line
    // separated by footnote symbols (*, ∗, †, ‡) without commas or semicolons.
    if (/[*∗⋆†‡§¶]/.test(line)) {
      const parts = line
        .split(/(?:[\s,]*[*∗⋆†‡§¶]+\s*)+/u)
        .map((s) => s.trim())
        .filter((s) => s.length >= 2 && !/^\d+$/.test(s));
      if (parts.length > 1) {
        for (const p of parts) {
          result.push(...splitAuthorString(p));
        }
        continue;
      }
    }

    result.push(line.trim());
  }

  return result.map(cleanAuthorName).filter(Boolean);
}

/**
 * Deterministically parses an author string into structured creator fields.
 * Handles:
 * - Institutional names (OpenAI, University of Cambridge, etc.)
 * - "LastName, FirstName MiddleName"
 * - "FirstName MiddleName LastName"
 * - Generational suffixes (Jr., Sr., III)
 * - Mononyms ("Aristotle", "Plato")
 */
export interface ParseCreatorOptions {
  preferSingleFieldForVietnamese?: boolean;
}

export function parseCreatorString(
  rawName: string,
  orderIndexOrOptions: number | ParseCreatorOptions = 0,
  creatorType: CreatorType = 'author',
  options?: ParseCreatorOptions,
): ParsedCreator {
  const orderIndex =
    typeof orderIndexOrOptions === 'number' ? orderIndexOrOptions : 0;
  const effectiveOptions =
    typeof orderIndexOrOptions === 'object' ? orderIndexOrOptions : options;

  const cleaned = cleanAuthorName(rawName);

  if (!cleaned) {
    return {
      orderIndex,
      creatorType,
      fieldMode: 0,
      firstName: '',
      lastName: '',
      fullName: '',
    };
  }

  if (isInstitutionName(cleaned)) {
    return {
      orderIndex,
      creatorType,
      fieldMode: 1,
      firstName: '',
      lastName: cleaned,
      fullName: cleaned,
    };
  }

  // Vancouver / Medline: "Smith JA" → lastName "Smith", firstName "J. A."
  if (!cleaned.includes(',') && isVancouverName(cleaned)) {
    const vTokens = cleaned.split(/\s+/);
    const initials = vTokens[vTokens.length - 1];
    const lastName = vTokens.slice(0, -1).join(' ');
    const firstName = initials
      .split('')
      .map((c) => `${c}.`)
      .join(' ');
    return {
      orderIndex,
      creatorType,
      fieldMode: 0,
      firstName,
      lastName,
      fullName: `${firstName} ${lastName}`,
    };
  }

  let workingName = cleaned;

  // Vietnamese naming order (Family Name First): e.g. "Nguyễn Văn An" -> Family: "Nguyễn", Given: "Văn An"
  if (!workingName.includes(',') && isVietnameseName(workingName)) {
    if (effectiveOptions?.preferSingleFieldForVietnamese) {
      return {
        orderIndex,
        creatorType,
        fieldMode: 1,
        firstName: '',
        lastName: workingName,
        fullName: workingName,
      };
    }

    const vnTokens = workingName.split(/\s+/);
    const lastName = vnTokens[0];
    const firstName = vnTokens.slice(1).join(' ');
    return {
      orderIndex,
      creatorType,
      fieldMode: 0,
      firstName,
      lastName,
      fullName: workingName,
    };
  }

  // Comma separated: "LastName, FirstName MiddleName", "Name, Jr.", "Last, Suffix, First", or "Last, First, Suffix"
  if (workingName.includes(',')) {
    const parts = workingName.split(',').map((p) => p.trim());
    if (parts.length === 2 && GENERATIONAL_SUFFIX_REGEX.test(parts[1])) {
      workingName = `${parts[0]} ${parts[1]}`;
    } else if (
      parts.length === 3 &&
      (GENERATIONAL_SUFFIX_REGEX.test(parts[1]) ||
        GENERATIONAL_SUFFIX_REGEX.test(parts[2]))
    ) {
      const isMiddleSuffix = GENERATIONAL_SUFFIX_REGEX.test(parts[1]);
      const rawLast = parts[0] || '';
      const rawSuffix = isMiddleSuffix ? parts[1] : parts[2];
      const rawFirst = isMiddleSuffix ? parts[2] : parts[1];
      const firstName = rawSuffix
        ? `${rawFirst} ${rawSuffix}`.trim()
        : rawFirst;
      const lastName = rawLast;
      const fullName = [rawFirst, rawLast, rawSuffix].filter(Boolean).join(' ');
      return {
        orderIndex,
        creatorType,
        fieldMode: 0,
        firstName,
        lastName,
        fullName,
      };
    } else {
      const lastName = parts[0] || '';
      const firstName = parts.slice(1).join(' ') || '';
      const fullName = firstName ? `${firstName} ${lastName}` : lastName;
      return {
        orderIndex,
        creatorType,
        fieldMode: 0,
        firstName,
        lastName,
        fullName,
      };
    }
  }

  // Space separated: "FirstName [MiddleName...] LastName [Suffix]"
  const tokens = workingName.split(' ');
  if (tokens.length === 1) {
    // Single word name / mononym (e.g. "Plato", "Aristotle")
    return {
      orderIndex,
      creatorType,
      fieldMode: 0,
      firstName: '',
      lastName: tokens[0],
      fullName: tokens[0],
    };
  }

  // Check if last token is generational suffix (e.g. "Martin Luther King Jr.")
  let splitIndex = tokens.length - 1;
  if (
    tokens.length >= 3 &&
    GENERATIONAL_SUFFIX_REGEX.test(tokens[tokens.length - 1])
  ) {
    splitIndex = tokens.length - 2;
  } else if (
    tokens.length >= 3 &&
    PREFIX_PARTICLES.has(tokens[tokens.length - 2].toLowerCase())
  ) {
    // Surname particles attach to the surname: "Vincent van Gogh", "Jean La Fontaine",
    // "Juan de la Cruz", "Ludwig van der Rohe", or multi-part "Johannes Diderik Van Der Waals".
    splitIndex = tokens.length - 2;
    while (
      splitIndex > 1 &&
      PREFIX_PARTICLES.has(tokens[splitIndex - 1].toLowerCase())
    ) {
      splitIndex--;
    }
  }

  const lastName = tokens.slice(splitIndex).join(' ');
  const firstName = tokens.slice(0, splitIndex).join(' ');
  const fullName = firstName ? `${firstName} ${lastName}` : lastName;

  return {
    orderIndex,
    creatorType,
    fieldMode: 0,
    firstName,
    lastName,
    fullName,
  };
}

export function extractFamilyName(authorName?: string | null): string {
  if (!authorName) return '';
  const trimmed = authorName.trim();
  if (trimmed.includes(',')) {
    return trimmed.split(',')[0].trim();
  }
  if (isVietnameseName(trimmed)) {
    const parts = trimmed.split(/\s+/);
    return parts[0] || '';
  }
  const parts = trimmed.split(/\s+/);
  return parts[parts.length - 1] || '';
}

export function normalizeCreators(
  creators?: CreatorInput[] | null,
  fallbackAuthors?: string[] | null,
): CreatorInput[] {
  if (Array.isArray(creators) && creators.length > 0) {
    return creators.map((c) => ({
      creatorType: c.creatorType || 'author',
      name:
        c.name ||
        [c.firstName, c.lastName].filter(Boolean).join(' ').trim() ||
        'Unknown',
      firstName: c.firstName,
      lastName: c.lastName,
      ...(c.fieldMode !== undefined ? { fieldMode: c.fieldMode } : {}),
    }));
  }
  if (Array.isArray(fallbackAuthors) && fallbackAuthors.length > 0) {
    return fallbackAuthors.map((name) => ({
      creatorType: 'author',
      name: name.trim(),
    }));
  }
  return [];
}

// PDF first-page accuracy helpers

/**
 * Rejects author candidates that are clearly prose (e.g. an abstract sentence
 * that bled into the author block: "We introduce Adam"). A person name is made
 * of capitalised tokens; the only lowercase tokens allowed are name particles.
 */
export function isPlausibleAuthorName(name?: string | null): boolean {
  if (!name) return false;
  const trimmed = name.trim();
  if (trimmed.includes(':')) return false;
  if (isNoiseAuthorName(trimmed)) return false;
  const tokens = trimmed.split(/\s+/);
  if (tokens.length === 0 || tokens.length > 8) return false;
  return tokens.every(
    (t) =>
      /^\p{Lu}/u.test(t) ||
      PREFIX_PARTICLES.has(t.toLowerCase()) ||
      !/\p{L}/u.test(t),
  );
}

/**
 * Splits a run of names that the PDF text layer joined without any delimiter,
 * e.g. "Kaiming He Xiangyu Zhang Shaoqing Ren Jian Sun".
 *
 * Heuristic: each name is `Given [Initial.]* [particle]* Surname`. The split is
 * only applied when the whole string parses cleanly into >= 2 names; otherwise
 * the input is returned untouched. Known limitation: a person with a given name
 * of two words and no initial (e.g. "Maria Del Carmen Lopez") is ambiguous, so
 * strings shorter than `minTokens` are left alone unless the caller opts in.
 */
export function splitConcatenatedAuthors(raw: string, minTokens = 6): string[] {
  const input = (raw || '').trim();
  if (!input) return [];
  if (/[,;@&]|\band\b/i.test(input)) return [input];

  const tokens = input.split(/\s+/);
  if (tokens.length < minTokens) return [input];
  if (isInstitutionName(input)) return [input];

  const isCap = (t: string) => /^\p{Lu}/u.test(t);
  const isInitial = (t: string) => /^\p{Lu}\.?$/u.test(t);
  const isParticle = (t: string) => PREFIX_PARTICLES.has(t);

  if (!tokens.every((t) => isCap(t) || isParticle(t))) return [input];

  const names: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const start = i;
    if (!isCap(tokens[i])) return [input];
    i++; // given name
    while (i < tokens.length && isInitial(tokens[i])) i++;
    while (i < tokens.length && isParticle(tokens[i])) i++;
    if (i >= tokens.length || !isCap(tokens[i])) return [input];
    i++; // surname
    names.push(tokens.slice(start, i).join(' '));
  }
  return names.length >= 2 ? names : [input];
}
