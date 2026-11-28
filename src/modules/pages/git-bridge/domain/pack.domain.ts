/**
 * git-bridge/domain/pack.domain.ts
 * - GoF Builder (`PktReportBuilder`) for Git Smart-HTTP pkt-line & side-band-64k framing
 * - GoF Chain of Responsibility (`runTreeGuards`, `runBlobGuards`) for push validation
 */

import {
  LfsUnsupportedError,
  PushRejectedError,
  QuotaExceededError,
} from './errors';
import {
  GitService,
  MAIN_REF,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_PUSH_BYTES,
  RepoPathVo,
} from './policy';

export const FLUSH_PKT = Buffer.from('0000', 'ascii');
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const LFS_HEADER = 'version https://git-lfs.github.com/spec/v1';

export function pktLine(payload: string | Buffer): Buffer {
  const body = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(payload, 'utf8');
  const hexLen = (body.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(hexLen, 'ascii'), body]);
}

export function hasSideband(stdout: Buffer): boolean {
  if (stdout.length < 5) return false;
  const band = stdout[4];
  return band === 0x01 || band === 0x02 || band === 0x03;
}

/**
 * GoF Builder: Constructs spec-compliant Git Smart-HTTP pkt-line payloads
 * (ref advertisements and plain/sideband `receive-pack` status reports).
 */
export class PktReportBuilder {
  private readonly frames: Buffer[] = [];

  public line(text: string): this {
    this.frames.push(pktLine(text));
    return this;
  }

  public band(channel: 1 | 2, data: Buffer | string): this {
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    this.frames.push(pktLine(Buffer.concat([Buffer.from([channel]), body])));
    return this;
  }

  public raw(buf: Buffer): this {
    this.frames.push(buf);
    return this;
  }

  public flush(): this {
    this.frames.push(FLUSH_PKT);
    return this;
  }

  public build(): Buffer {
    return Buffer.concat(this.frames);
  }

  public static advertise(service: GitService, refs: Buffer): Buffer {
    return new PktReportBuilder()
      .line(`# service=${service}\n`)
      .flush()
      .raw(refs)
      .build();
  }

  public static reject(
    reason: string,
    opts: { ref?: string; sideband?: boolean } = {},
  ): Buffer {
    const clean = reason.replace(/[\r\n]+/g, ' ').trim();
    const ref = opts.ref || MAIN_REF;
    const status = new PktReportBuilder()
      .line('unpack ok\n')
      .line(`ng ${ref} ${clean}\n`)
      .flush()
      .build();

    if (!opts.sideband) return status;

    return new PktReportBuilder()
      .band(2, `\nFlux Git Bridge: ${clean}\n\n`)
      .band(1, status)
      .flush()
      .build();
  }
}

// ─── GoF Chain of Responsibility: Composable Push Guards ────────────────────

export interface TreeEntryCtx {
  readonly mode: string;
  readonly rawPath: string;
  readonly fileCount: number;
}

export interface BlobCtx {
  readonly path: RepoPathVo;
  readonly content: Buffer;
  readonly cumulativeBytes: number;
}

type GuardFn<T> = (ctx: T) => void;

const TREE_GUARDS: readonly GuardFn<TreeEntryCtx>[] = [
  ({ mode, rawPath }) => {
    const m = mode.padStart(6, '0');
    if (m === '160000') {
      throw new PushRejectedError(
        `Git submodules are not supported ("${rawPath}")`,
      );
    }
    if (m === '120000') {
      throw new PushRejectedError(
        `Symbolic links are not supported ("${rawPath}")`,
      );
    }
  },
  ({ rawPath }) => {
    RepoPathVo.fromRepo(rawPath);
  },
  ({ fileCount }) => {
    if (fileCount > MAX_FILES) {
      throw new PushRejectedError(
        `Repository exceeds maximum limit of ${MAX_FILES} files`,
      );
    }
  },
];

export function isLfsPointer(buf: Buffer): boolean {
  if (buf.length < LFS_HEADER.length || buf.length > 1024) return false;
  const head = buf
    .subarray(0, LFS_HEADER.length + 16)
    .toString('utf8')
    .replace(/^\uFEFF/, '');
  if (!head.startsWith(LFS_HEADER)) return false;
  const text = buf.toString('utf8');
  return text.includes('\noid sha256:') && text.includes('\nsize ');
}

const BLOB_GUARDS: readonly GuardFn<BlobCtx>[] = [
  ({ content, path }) => {
    if (isLfsPointer(content)) {
      throw new LfsUnsupportedError(path.repo);
    }
  },
  ({ content, path }) => {
    if (content.length > MAX_FILE_BYTES) {
      throw new QuotaExceededError(
        `File "${path.project}" exceeds 50 MB limit (${content.length} bytes)`,
      );
    }
  },
  ({ cumulativeBytes }) => {
    if (cumulativeBytes > MAX_PUSH_BYTES) {
      throw new QuotaExceededError('Push payload exceeds 200 MB total limit');
    }
  },
];

export function runTreeGuards(ctx: TreeEntryCtx): void {
  for (const guard of TREE_GUARDS) guard(ctx);
}

export function runBlobGuards(ctx: BlobCtx): void {
  for (const guard of BLOB_GUARDS) guard(ctx);
}

export function splitLines(text: string): string[] {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n');
}
