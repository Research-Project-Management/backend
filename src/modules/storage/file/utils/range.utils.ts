export type ByteRange =
  | {
      success: true;
      start: number;
      end: number;
      length: number;
      contentRange: string;
    }
  | {
      success: false;
      error: 'INVALID' | 'UNSATISFIABLE' | 'MULTIPLE_RANGES';
      contentRange: string;
    };

/**
 * Parses and validates HTTP Range requests according to RFC 7233.
 * Supports:
 *  - bytes=start-end (e.g. bytes=0-99)
 *  - bytes=start- (e.g. bytes=100-)
 *  - bytes=-suffix (e.g. bytes=-500)
 * Rejects invalid, inverted, out-of-bounds, or multiple ranges with typed error.
 */
export function parseByteRange(
  rangeHeader: string | undefined,
  totalSize: number,
): ByteRange {
  if (!rangeHeader || typeof rangeHeader !== 'string') {
    return {
      success: false,
      error: 'INVALID',
      contentRange: `bytes */${totalSize}`,
    };
  }

  const trimmed = rangeHeader.trim();
  if (!trimmed.startsWith('bytes=')) {
    return {
      success: false,
      error: 'INVALID',
      contentRange: `bytes */${totalSize}`,
    };
  }

  const spec = trimmed.slice(6).trim();
  if (spec.includes(',')) {
    return {
      success: false,
      error: 'MULTIPLE_RANGES',
      contentRange: `bytes */${totalSize}`,
    };
  }

  // Handle suffix range: bytes=-500
  if (spec.startsWith('-')) {
    const suffixStr = spec.slice(1).trim();
    if (!/^\d+$/.test(suffixStr)) {
      return {
        success: false,
        error: 'INVALID',
        contentRange: `bytes */${totalSize}`,
      };
    }
    const suffix = parseInt(suffixStr, 10);
    if (suffix <= 0) {
      return {
        success: false,
        error: 'INVALID',
        contentRange: `bytes */${totalSize}`,
      };
    }
    if (totalSize === 0) {
      return {
        success: false,
        error: 'UNSATISFIABLE',
        contentRange: `bytes */0`,
      };
    }
    const start = Math.max(0, totalSize - suffix);
    const end = totalSize - 1;
    const length = end - start + 1;
    return {
      success: true,
      start,
      end,
      length,
      contentRange: `bytes ${start}-${end}/${totalSize}`,
    };
  }

  // Handle start-end or start-
  const parts = spec.split('-');
  if (parts.length !== 2) {
    return {
      success: false,
      error: 'INVALID',
      contentRange: `bytes */${totalSize}`,
    };
  }

  const startStr = parts[0].trim();
  const endStr = parts[1].trim();

  if (!/^\d+$/.test(startStr)) {
    return {
      success: false,
      error: 'INVALID',
      contentRange: `bytes */${totalSize}`,
    };
  }

  const start = parseInt(startStr, 10);
  if (start >= totalSize || totalSize <= 0) {
    return {
      success: false,
      error: 'UNSATISFIABLE',
      contentRange: `bytes */${totalSize}`,
    };
  }

  let end: number;
  if (endStr === '') {
    end = totalSize - 1;
  } else {
    if (!/^\d+$/.test(endStr)) {
      return {
        success: false,
        error: 'INVALID',
        contentRange: `bytes */${totalSize}`,
      };
    }
    end = parseInt(endStr, 10);
    if (end < start) {
      return {
        success: false,
        error: 'INVALID',
        contentRange: `bytes */${totalSize}`,
      };
    }
    if (end >= totalSize) {
      end = totalSize - 1;
    }
  }

  const length = end - start + 1;
  return {
    success: true,
    start,
    end,
    length,
    contentRange: `bytes ${start}-${end}/${totalSize}`,
  };
}
