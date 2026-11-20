/**
 * modules/pages/core/domain/latex-preamble.ts
 * Pure domain helper resolving script-appropriate LaTeX font encoding / Unicode
 * preamble packages and engine directives from document metadata.
 */

export const VIETNAMESE_LATIN_REGEX =
  /[\u0102\u0103\u0110\u0111\u0128\u0129\u0168\u0169\u01A0\u01A1\u01AF\u01B0\u1EA0-\u1EF9]/;

export interface UnicodePreambleResolution {
  magicComments: string[];
  packages: string[];
}

export function hasVietnameseCharacters(text: string): boolean {
  if (!text) return false;
  return VIETNAMESE_LATIN_REGEX.test(text.normalize('NFC'));
}

function isSupportedEightBitLatinCodePoint(cp: number): boolean {
  return (
    cp <= 0x007f ||
    (cp >= 0x00a0 && cp <= 0x024f) ||
    (cp >= 0x1e00 && cp <= 0x1eff) ||
    (cp >= 0x2000 && cp <= 0x206f)
  );
}

export function resolveUnicodePreamblePackages(
  metadataTexts: readonly string[],
): UnicodePreambleResolution {
  const combined = metadataTexts.filter(Boolean).join('\n').normalize('NFC');
  if (!combined) {
    return { magicComments: [], packages: [] };
  }

  let hasNonAscii = false;
  let hasNonLatinScript = false;

  for (const ch of combined) {
    const cp = ch.codePointAt(0);
    if (cp === undefined || cp <= 0x007f) continue;
    hasNonAscii = true;
    if (!isSupportedEightBitLatinCodePoint(cp)) {
      hasNonLatinScript = true;
      break;
    }
  }

  if (!hasNonAscii) {
    return { magicComments: [], packages: [] };
  }

  if (hasNonLatinScript) {
    return {
      magicComments: ['% !TEX program = xelatex'],
      packages: ['\\usepackage{fontspec}'],
    };
  }

  if (VIETNAMESE_LATIN_REGEX.test(combined)) {
    return {
      magicComments: [],
      packages: ['\\usepackage[T5]{fontenc}'],
    };
  }

  return {
    magicComments: [],
    packages: ['\\usepackage[T1]{fontenc}'],
  };
}
