/**
 * Clean-as-You-Code Diff Coverage Gate (zero external dependencies).
 *
 * Parses `git diff --unified=0 <base>...HEAD -- src/` and `coverage/lcov.info`
 * to verify that newly added/modified executable lines meet the threshold
 * (default: 80%). Legacy untouched lines are ignored.
 *
 * Usage:
 *   ts-node --transpile-only scripts/gates/verify-diff-coverage.ts [--base=origin/master] [--min=80]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

interface LcovFile {
  lines: Map<number, number>; // line -> hit count
}

function parseArgs(): { base: string; min: number; lcovPath: string } {
  const args = process.argv.slice(2);
  let base = 'origin/master';
  let min = 80;
  let lcovPath = 'coverage/lcov.info';
  for (const arg of args) {
    if (arg.startsWith('--base=')) base = arg.slice('--base='.length);
    else if (arg.startsWith('--min=')) min = Number(arg.slice('--min='.length));
    else if (arg.startsWith('--lcov=')) lcovPath = arg.slice('--lcov='.length);
  }
  return { base, min, lcovPath };
}

function getChangedLines(repoRoot: string, base: string): Map<string, Set<number>> {
  let diffOut = '';
  try {
    diffOut = execFileSync(
      'git',
      ['diff', '--unified=0', `${base}...HEAD`, '--', 'src/'],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
    );
  } catch (err: unknown) {
    // Fallback to staged/working-tree diff when running locally without a remote base ref
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[diff-cov] Could not diff against "${base}" (${msg.split('\n')[0]}). Falling back to HEAD diff.`);
    diffOut = execFileSync(
      'git',
      ['diff', '--unified=0', 'HEAD', '--', 'src/'],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
    );
  }

  const changed = new Map<string, Set<number>>();
  let currentFile: string | null = null;

  for (const line of diffOut.split('\n')) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6).trim().replaceAll('\\', '/');
      if (!changed.has(currentFile)) changed.set(currentFile, new Set());
    } else if (line.startsWith('@@ ') && currentFile) {
      const m = /\+(\d+)(?:,(\d+))?/.exec(line);
      if (m) {
        const start = Number(m[1]);
        const count = m[2] === undefined ? 1 : Number(m[2]);
        const set = changed.get(currentFile)!;
        for (let ln = start; ln < start + count; ln++) {
          set.add(ln);
        }
      }
    }
  }
  return changed;
}

function parseLcov(lcovFullPath: string, repoRoot: string): Map<string, LcovFile> {
  const result = new Map<string, LcovFile>();
  const text = readFileSync(lcovFullPath, 'utf8');
  let current: LcovFile | null = null;

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      const sfPath = line.slice(3);
      const rel = relative(repoRoot, resolve(repoRoot, sfPath)).replaceAll('\\', '/');
      current = { lines: new Map() };
      result.set(rel, current);
    } else if (line.startsWith('DA:') && current) {
      const [lnStr, hitsStr] = line.slice(3).split(',');
      current.lines.set(Number(lnStr), Number(hitsStr));
    } else if (line === 'end_of_record') {
      current = null;
    }
  }
  return result;
}

function main(): void {
  const repoRoot = resolve(__dirname, '..', '..');
  const { base, min, lcovPath } = parseArgs();
  const lcovFull = resolve(repoRoot, lcovPath);

  const changed = getChangedLines(repoRoot, base);
  const changedSrcFiles = [...changed.entries()].filter(
    ([f, lines]) =>
      lines.size > 0 &&
      (f.endsWith('.ts') || f.endsWith('.tsx')) &&
      !f.endsWith('.d.ts') &&
      !f.endsWith('.spec.ts') &&
      !f.endsWith('.test.ts'),
  );

  if (changedSrcFiles.length === 0) {
    console.log('✔ diff-coverage: no changed executable source lines under src/.');
    return;
  }

  if (!existsSync(lcovFull)) {
    console.error(`✖ diff-coverage: missing ${lcovPath}. Run unit tests with --coverage first.`);
    process.exit(1);
  }

  const lcov = parseLcov(lcovFull, repoRoot);
  let totalExec = 0;
  let totalCovered = 0;
  const uncovered: string[] = [];

  for (const [file, lineSet] of changedSrcFiles) {
    const cov = lcov.get(file);
    if (!cov) continue;
    for (const ln of [...lineSet].sort((a, b) => a - b)) {
      const hits = cov.lines.get(ln);
      if (hits === undefined) continue; // non-executable line (type, comment, blank)
      totalExec++;
      if (hits > 0) {
        totalCovered++;
      } else {
        uncovered.push(`${file}:${ln}`);
      }
    }
  }

  if (totalExec === 0) {
    console.log('✔ diff-coverage: 0 executable lines changed in tracked coverage files.');
    return;
  }

  const pct = (totalCovered / totalExec) * 100;
  const formatted = pct.toFixed(1);

  if (pct < min) {
    console.error(
      `✖ diff-coverage failed: ${formatted}% (${totalCovered}/${totalExec} changed lines covered) < ${min}% minimum.`,
    );
    console.error('  Fix: add unit tests covering these changed lines:');
    for (const u of uncovered.slice(0, 25)) {
      console.error(`  - ${u}`);
    }
    if (uncovered.length > 25) {
      console.error(`  ... and ${uncovered.length - 25} more.`);
    }
    process.exit(1);
  }

  console.log(`✔ diff-coverage passed: ${formatted}% (${totalCovered}/${totalExec} changed lines covered, min ${min}%).`);
}

main();
