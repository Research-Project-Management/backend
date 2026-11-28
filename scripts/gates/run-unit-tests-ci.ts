/**
 * Blocking CI Unit Test Runner with explicit Quarantine list.
 * Runs all non-quarantined Jest suites with strict exit code (no `|| true`).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface QuarantineFile {
  suites: string[];
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function main(): void {
  const repoRoot = resolve(__dirname, '..', '..');
  const qPath = resolve(repoRoot, 'test/quarantine.json');
  const extraArgs = process.argv.slice(2);

  let suites: string[] = [];
  if (existsSync(qPath)) {
    const parsed = JSON.parse(readFileSync(qPath, 'utf8')) as QuarantineFile;
    suites = parsed.suites ?? [];
  }

  const jestArgs = ['exec', 'jest', '--forceExit', ...extraArgs];
  if (suites.length > 0) {
    for (const suite of suites) {
      // Match both POSIX `/` and Windows `\` path separators without shell pipe `|`
      const normalized = escapeRegex(suite).replaceAll('/', '[\\\\/]');
      jestArgs.push('--testPathIgnorePatterns', normalized);
    }
    console.log(`[test:ci] Running all unit suites (quarantined: ${suites.length} legacy suite(s)).`);
  }

  const res = spawnSync('pnpm', jestArgs, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  process.exit(res.status ?? 1);
}

main();
