import { parseByteRange } from '@/modules/storage/file/utils/range.utils';

describe('Range Parser Utility Unit Tests (HTTP 206 / RFC 7233 Matrix)', () => {
  const totalSize = 1000;

  it('parses standard range bytes=0-99 (start to end inclusive)', () => {
    const result = parseByteRange('bytes=0-99', totalSize);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.start).toBe(0);
      expect(result.end).toBe(99);
      expect(result.length).toBe(100);
      expect(result.contentRange).toBe('bytes 0-99/1000');
    }
  });

  it('parses open-ended range bytes=100- (from offset to end of file)', () => {
    const result = parseByteRange('bytes=100-', totalSize);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.start).toBe(100);
      expect(result.end).toBe(999);
      expect(result.length).toBe(900);
      expect(result.contentRange).toBe('bytes 100-999/1000');
    }
  });

  it('parses suffix range bytes=-500 (last 500 bytes of file)', () => {
    const result = parseByteRange('bytes=-500', totalSize);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.start).toBe(500);
      expect(result.end).toBe(999);
      expect(result.length).toBe(500);
      expect(result.contentRange).toBe('bytes 500-999/1000');
    }
  });

  it('clamps suffix range when requested suffix length exceeds total size', () => {
    const result = parseByteRange('bytes=-2000', totalSize);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.start).toBe(0);
      expect(result.end).toBe(999);
      expect(result.length).toBe(1000);
      expect(result.contentRange).toBe('bytes 0-999/1000');
    }
  });

  it('rejects out-of-bounds start offset bytes=999999- with UNSATISFIABLE (416)', () => {
    const result = parseByteRange('bytes=999999-', totalSize);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('UNSATISFIABLE');
      expect(result.contentRange).toBe('bytes */1000');
    }
  });

  it('rejects inverted range bytes=500-100 with INVALID (416)', () => {
    const result = parseByteRange('bytes=500-100', totalSize);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('INVALID');
      expect(result.contentRange).toBe('bytes */1000');
    }
  });

  it('rejects non-numeric range bytes=a-b with INVALID (416)', () => {
    const result = parseByteRange('bytes=a-b', totalSize);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('INVALID');
      expect(result.contentRange).toBe('bytes */1000');
    }
  });

  it('rejects multiple ranges bytes=0-10,20-30 with MULTIPLE_RANGES (416)', () => {
    const result = parseByteRange('bytes=0-10,20-30', totalSize);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('MULTIPLE_RANGES');
      expect(result.contentRange).toBe('bytes */1000');
    }
  });
});
