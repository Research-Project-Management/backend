import { randomBytes } from 'crypto';

let lastTime = 0;
let seq = 0;

/**
 * Generates an RFC 9562 compliant UUID v7 string using Node's native `crypto`.
 * Time-ordered 128-bit identifier with 48-bit millisecond precision and monotonic sequence.
 */
export function uuidv7(): string {
  const bytes = randomBytes(16);

  const now = Date.now();
  if (now > lastTime) {
    lastTime = now;
    seq = ((bytes[6] & 0x0f) << 8) | bytes[7];
  } else {
    seq = (seq + 1) & 0x0fff;
  }

  bytes[0] = Math.floor(now / 0x10000000000) & 0xff;
  bytes[1] = Math.floor(now / 0x100000000) & 0xff;
  bytes[2] = Math.floor(now / 0x1000000) & 0xff;
  bytes[3] = Math.floor(now / 0x10000) & 0xff;
  bytes[4] = Math.floor(now / 0x100) & 0xff;
  bytes[5] = now & 0xff;

  bytes[6] = 0x70 | ((seq >> 8) & 0x0f);
  bytes[7] = seq & 0xff;

  bytes[8] = 0x80 | (bytes[8] & 0x3f);

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
