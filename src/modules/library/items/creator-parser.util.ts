import { CreatorType } from './items.types';

export interface ParsedCreator {
  orderIndex: number;
  creatorType: CreatorType;
  firstName: string;
  lastName: string;
  fullName: string;
}

export const INSTITUTION_KEYWORDS = [
  'organization',
  'organizations',
  'organisation',
  'organisations',
  'association',
  'associations',
  'institute',
  'institutes',
  'institution',
  'institutions',
  'university',
  'universities',
  'laboratory',
  'laboratories',
  'collab',
  'collaboration',
  'collaborations',
  'group',
  'team',
  'consortium',
  'network',
  'department',
  'departments',
  'agency',
  'agencies',
  'center',
  'centers',
  'centre',
  'centres',
  'foundation',
  'corporation',
  'inc',
  'llc',
  'ltd',
  'hospital',
  'hospitals',
  'openai',
  'google',
  'microsoft',
  'meta',
  'deepmind',
  'anthropic',
  'mit',
  'cern',
  'nasa',
  'who',
  'ieee',
  'acm',
];

/**
 * Splits a composite string of authors separated by ';', ' and ', ' & ', or newlines.
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
    if (line.includes(';')) {
      result.push(...line.split(';').map((s) => s.trim()).filter(Boolean));
    } else if (/\s+and\s+/i.test(line)) {
      result.push(
        ...line.split(/\s+and\s+/i).map((s) => s.trim()).filter(Boolean),
      );
    } else if (/\s+&\s+/.test(line)) {
      result.push(
        ...line.split(/\s+&\s+/).map((s) => s.trim()).filter(Boolean),
      );
    } else if ((line.match(/,/g) || []).length >= 2) {
      result.push(
        ...line.split(',').map((s) => s.trim()).filter(Boolean),
      );
    } else {
      result.push(line);
    }
  }

  return result;
}

const PREFIX_PARTICLES = new Set([
  'von',
  'van',
  'de',
  'del',
  'der',
  'da',
  'di',
  'du',
  'la',
  'le',
]);

/**
 * Deterministically parses an author string into structured creator fields.
 * Handles:
 * - Institutional names (OpenAI, University of Cambridge, etc.)
 * - "LastName, FirstName MiddleName"
 * - "FirstName MiddleName LastName"
 * - Mononyms ("Aristotle", "Plato")
 */
export function parseCreatorString(
  rawName: string,
  orderIndex: number = 0,
  creatorType: CreatorType = 'author',
): ParsedCreator {
  const trimmed = (rawName || '').trim().replace(/\s+/g, ' ');

  if (!trimmed) {
    return {
      orderIndex,
      creatorType,
      firstName: '',
      lastName: '',
      fullName: '',
    };
  }

  const lower = trimmed.toLowerCase();
  const isInstitution = INSTITUTION_KEYWORDS.some((kw) =>
    new RegExp(`\\b${kw}\\b`, 'i').test(lower),
  );

  if (isInstitution) {
    return {
      orderIndex,
      creatorType,
      firstName: '',
      lastName: trimmed,
      fullName: trimmed,
    };
  }

  // Comma separated: "LastName, FirstName MiddleName"
  if (trimmed.includes(',')) {
    const parts = trimmed.split(',').map((p) => p.trim());
    const lastName = parts[0] || '';
    const firstName = parts.slice(1).join(' ') || '';
    const fullName = firstName ? `${firstName} ${lastName}` : lastName;
    return {
      orderIndex,
      creatorType,
      firstName,
      lastName,
      fullName,
    };
  }

  // Space separated: "FirstName [MiddleName...] LastName"
  const tokens = trimmed.split(' ');
  if (tokens.length === 1) {
    // Single word name / mononym (e.g. "Plato", "Aristotle")
    return {
      orderIndex,
      creatorType,
      firstName: '',
      lastName: tokens[0],
      fullName: tokens[0],
    };
  }

  // Handle prefix particles like "von Neumann", "van Beethoven", "de Fermat"
  let splitIndex = tokens.length - 1;
  if (
    tokens.length >= 3 &&
    PREFIX_PARTICLES.has(tokens[tokens.length - 2].toLowerCase())
  ) {
    splitIndex = tokens.length - 2;
    if (
      tokens.length >= 4 &&
      PREFIX_PARTICLES.has(tokens[tokens.length - 3].toLowerCase())
    ) {
      splitIndex = tokens.length - 3;
    }
  }

  const lastName = tokens.slice(splitIndex).join(' ');
  const firstName = tokens.slice(0, splitIndex).join(' ');

  return {
    orderIndex,
    creatorType,
    firstName,
    lastName,
    fullName: trimmed,
  };
}
