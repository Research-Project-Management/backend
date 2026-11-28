/**
 * Shared SHA-256 Syntax Fingerprint Baseline engine (ratchet pattern).
 * Locks legacy findings by (relative file path, syntax token hash) so line-number
 * shifts never cause false positives, while every NEW violation fails immediately.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

export interface Finding {
  file: string;
  line: number;
  fingerprint: string;
  detail?: string;
}

/** Map of relative POSIX path -> sorted map of fingerprint -> allowed count. */
export type BaselineMap = Record<string, Record<string, number>>;

export function walkTsFiles(dir: string, repoRoot: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'coverage') {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTsFiles(full, repoRoot, out);
    } else if (
      entry.isFile() &&
      (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(relative(repoRoot, full).replaceAll('\\', '/'));
    }
  }
  return out;
}

/**
 * Compute a stable SHA-256 hash over a node's syntax tokens (ignoring whitespace and comments).
 * Shifting line numbers or reformatting never invalidates the fingerprint.
 */
export function syntaxFingerprint(node: ts.Node, source: ts.SourceFile, salt = ''): string {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ true,
    source.languageVariant,
    source.text.slice(node.getStart(source), node.getEnd()),
  );
  const tokens: string[] = [];
  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    tokens.push(`${token}:${scanner.getTokenText()}`);
    token = scanner.scan();
  }
  const payload = salt ? `${salt}\0${tokens.join(' ')}` : tokens.join(' ');
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

export function countFindings(findings: readonly Finding[]): BaselineMap {
  const map: BaselineMap = {};
  for (const f of findings) {
    map[f.file] ??= {};
    map[f.file][f.fingerprint] = (map[f.file][f.fingerprint] ?? 0) + 1;
  }
  const sorted: BaselineMap = {};
  for (const file of Object.keys(map).sort()) {
    const inner: Record<string, number> = {};
    for (const fp of Object.keys(map[file]).sort()) {
      inner[fp] = map[file][fp];
    }
    sorted[file] = inner;
  }
  return sorted;
}

export function readBaseline(baselinePath: string): BaselineMap {
  if (!existsSync(baselinePath)) return {};
  return JSON.parse(readFileSync(baselinePath, 'utf8')) as BaselineMap;
}

export function writeBaseline(baselinePath: string, data: BaselineMap): void {
  mkdirSync(dirname(baselinePath), { recursive: true });
  writeFileSync(baselinePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export interface VerifyResult {
  newViolations: Finding[];
  staleEntries: number;
  totalObserved: number;
}

export function verifyAgainstBaseline(
  findings: readonly Finding[],
  baseline: BaselineMap,
  scopedFiles?: ReadonlySet<string>,
): VerifyResult {
  const remaining: Record<string, Record<string, number>> = {};
  for (const [file, fps] of Object.entries(baseline)) {
    if (scopedFiles && !scopedFiles.has(file)) continue;
    remaining[file] = { ...fps };
  }

  const newViolations: Finding[] = [];
  for (const f of findings) {
    const allowed = remaining[f.file]?.[f.fingerprint] ?? 0;
    if (allowed > 0) {
      remaining[f.file][f.fingerprint] = allowed - 1;
    } else {
      newViolations.push(f);
    }
  }

  let staleEntries = 0;
  for (const fps of Object.values(remaining)) {
    for (const count of Object.values(fps)) {
      staleEntries += count;
    }
  }

  return { newViolations, staleEntries, totalObserved: findings.length };
}

export function resolveRepoRoot(): string {
  return resolve(__dirname, '..', '..');
}
