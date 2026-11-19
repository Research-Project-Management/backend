/**
 * modules/pages/spelling/domain/morphology-stemmer.ts
 * Pure morphological stemming and bounded Damerau-Levenshtein distance helpers.
 * Zero I/O, zero NestJS imports.
 */

export function getRomanceGermanicStems(
  word: string,
  baseLang: string,
): string[] {
  const stems: string[] = [];
  if (word.length <= 3) return stems;

  if (baseLang === 'fr') {
    for (const suffix of [
      'ements',
      'ement',
      'ations',
      'ation',
      'iques',
      'ique',
      'ables',
      'able',
      'euses',
      'euse',
      'eurs',
      'eur',
      'aux',
      'ent',
      'ées',
      'és',
      'ée',
      'er',
      'ir',
      'es',
      's',
      'e',
    ]) {
      if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
        stems.push(word.slice(0, -suffix.length));
        stems.push(word.slice(0, -suffix.length) + 'e');
        stems.push(word.slice(0, -suffix.length) + 'er');
      }
    }
  } else if (baseLang === 'de') {
    for (const suffix of [
      'ungen',
      'ung',
      'keiten',
      'keit',
      'heiten',
      'heit',
      'ische',
      'ischen',
      'ischer',
      'isches',
      'isch',
      'ieren',
      'iert',
      'ern',
      'eln',
      'en',
      'er',
      'es',
      'em',
      'st',
      'te',
      'ten',
      'e',
      's',
      'n',
    ]) {
      if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
        stems.push(word.slice(0, -suffix.length));
        stems.push(word.slice(0, -suffix.length) + 'en');
      }
    }
  } else if (baseLang === 'es') {
    for (const suffix of [
      'aciones',
      'ación',
      'acion',
      'amientos',
      'amiento',
      'mente',
      'idades',
      'idad',
      'ables',
      'able',
      'ibles',
      'ible',
      'ando',
      'iendo',
      'ados',
      'adas',
      'ado',
      'ada',
      'idos',
      'idas',
      'ido',
      'ida',
      'aron',
      'ieron',
      'aban',
      'ían',
      'es',
      'as',
      'os',
      'an',
      'en',
      'ar',
      'er',
      'ir',
      's',
      'a',
      'o',
    ]) {
      if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
        stems.push(word.slice(0, -suffix.length));
        stems.push(word.slice(0, -suffix.length) + 'o');
        stems.push(word.slice(0, -suffix.length) + 'a');
        stems.push(word.slice(0, -suffix.length) + 'ar');
        stems.push(word.slice(0, -suffix.length) + 'er');
      }
    }
  }

  return stems;
}

export function getMorphologicalStems(word: string): string[] {
  const stems: string[] = [];

  if (word.endsWith('ies') && word.length > 4) {
    stems.push(word.slice(0, -3) + 'y');
  } else if (word.endsWith('es') && word.length > 3) {
    stems.push(word.slice(0, -2));
    stems.push(word.slice(0, -1));
  } else if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) {
    stems.push(word.slice(0, -1));
  }

  if (word.endsWith('ied') && word.length > 4) {
    stems.push(word.slice(0, -3) + 'y');
  } else if (word.endsWith('ed') && word.length > 3) {
    stems.push(word.slice(0, -2));
    stems.push(word.slice(0, -1));
    if (
      word.length > 5 &&
      word.charAt(word.length - 3) === word.charAt(word.length - 4)
    ) {
      stems.push(word.slice(0, -3));
    }
  }

  if (word.endsWith('ing') && word.length > 4) {
    stems.push(word.slice(0, -3));
    stems.push(word.slice(0, -3) + 'e');
    if (
      word.length > 5 &&
      word.charAt(word.length - 4) === word.charAt(word.length - 5)
    ) {
      stems.push(word.slice(0, -4));
    }
  }

  if (word.endsWith('ally') && word.length > 5) {
    stems.push(word.slice(0, -4));
    stems.push(word.slice(0, -2));
  } else if (word.endsWith('ily') && word.length > 4) {
    stems.push(word.slice(0, -3) + 'y');
  } else if (word.endsWith('ly') && word.length > 4) {
    stems.push(word.slice(0, -2));
  }

  if (word.endsWith('able') && word.length > 5) {
    stems.push(word.slice(0, -4));
    stems.push(word.slice(0, -4) + 'e');
  }
  if (word.endsWith('ment') && word.length > 5) {
    stems.push(word.slice(0, -4));
  }
  if (word.endsWith('ness') && word.length > 5) {
    stems.push(word.slice(0, -4));
  }
  if (word.endsWith('ity') && word.length > 5) {
    stems.push(word.slice(0, -3));
    stems.push(word.slice(0, -3) + 'e');
  }

  return stems;
}

export function levenshteinDamerau(
  source: string,
  target: string,
  maxDist = 2,
): number {
  let sStart = 0;
  let sEnd = source.length;
  let tEnd = target.length;

  if (Math.abs(sEnd - tEnd) > maxDist) return maxDist + 1;

  // Trim shared prefix
  while (
    sStart < sEnd &&
    sStart < tEnd &&
    source.charCodeAt(sStart) === target.charCodeAt(sStart)
  ) {
    sStart++;
  }

  // Trim shared suffix
  while (
    sEnd > sStart &&
    tEnd > sStart &&
    source.charCodeAt(sEnd - 1) === target.charCodeAt(tEnd - 1)
  ) {
    sEnd--;
    tEnd--;
  }

  const sLen = sEnd - sStart;
  const tLen = tEnd - sStart;

  if (sLen === 0) return tLen;
  if (tLen === 0) return sLen;

  const requiredSize = tLen + 1;
  let prevPrev = new Int32Array(requiredSize);
  let prev = new Int32Array(requiredSize);
  let curr = new Int32Array(requiredSize);

  for (let j = 0; j <= tLen; j++) {
    prev[j] = j;
  }

  for (let i = 1; i <= sLen; i++) {
    curr[0] = i;
    let rowMin = i;
    const sChar = source.charCodeAt(sStart + i - 1);
    const prevSChar = i > 1 ? source.charCodeAt(sStart + i - 2) : -1;

    for (let j = 1; j <= tLen; j++) {
      const tChar = target.charCodeAt(sStart + j - 1);
      const cost = sChar === tChar ? 0 : 1;

      let val = prev[j - 1] + cost;
      const del = prev[j] + 1;
      const ins = curr[j - 1] + 1;
      if (del < val) val = del;
      if (ins < val) val = ins;

      if (
        i > 1 &&
        j > 1 &&
        sChar === target.charCodeAt(sStart + j - 2) &&
        prevSChar === tChar
      ) {
        const trans = prevPrev[j - 2] + 1;
        if (trans < val) val = trans;
      }

      curr[j] = val;
      if (val < rowMin) rowMin = val;
    }

    if (rowMin > maxDist) {
      return maxDist + 1;
    }

    const tmp = prevPrev;
    prevPrev = prev;
    prev = curr;
    curr = tmp;
  }

  return prev[tLen];
}
