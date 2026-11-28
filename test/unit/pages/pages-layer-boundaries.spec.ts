import * as fs from 'fs';
import * as path from 'path';

const PAGES_ROOT = path.resolve(__dirname, '../../../src/modules/pages');

const SUBMODULE_TIERS: Record<string, number> = {
  // Tier 0: Shared Kernel
  core: 0,
  // Tier 1: VFS & Aggregate Spine (filestore -> docstore -> {page, structure})
  filestore: 1,
  docstore: 2,
  page: 3,
  structure: 3,
  // Tier 2: Versioning, Review & Compilation ({review, history} -> clsi)
  review: 4,
  history: 4,
  clsi: 5,
  // Tier 3: Leaf Capabilities, Academic Integrations & BFF Aggregator
  spelling: 6,
  templates: 6,
  citations: 6,
  'git-bridge': 6,
  'export-import': 6,
  bootstrap: 6,
};

function collectTsFiles(dirPath: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results;
}

function extractModuleSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const regex =
    /^\s*(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    specs.push(match[1]);
  }
  return specs;
}

describe('Pages Backend Architecture — 4-Tier Acyclic DAG & Entry-Point Boundaries', () => {
  const allFiles = collectTsFiles(PAGES_ROOT);

  it('has all 14 canonical submodules with index.ts entry points exporting *Module last', () => {
    const dirs = fs
      .readdirSync(PAGES_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();

    expect(dirs).toEqual(Object.keys(SUBMODULE_TIERS).sort());

    for (const sub of dirs) {
      const indexPath = path.join(PAGES_ROOT, sub, 'index.ts');
      expect(fs.existsSync(indexPath)).toBe(true);
      const lines = fs
        .readFileSync(indexPath, 'utf8')
        .trim()
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0);
      expect(lines[lines.length - 1]).toMatch(/\.module['"];?$/);
    }
  });

  it('contains zero forwardRef workarounds across all 14 submodules', () => {
    const violations: string[] = [];
    for (const file of allFiles) {
      const content = fs.readFileSync(file, 'utf8');
      if (/\bforwardRef\s*\(/.test(content)) {
        violations.push(path.relative(PAGES_ROOT, file).replace(/\\/g, '/'));
      }
    }
    expect(violations).toEqual([]);
  });

  it('enforces index.ts entry-point boundaries and strict upward-free DAG ordering across submodules', () => {
    const deepImportViolations: string[] = [];
    const tierViolations: string[] = [];

    for (const file of allFiles) {
      const rel = path.relative(PAGES_ROOT, file).replace(/\\/g, '/');
      const parts = rel.split('/');
      if (parts.length < 2) continue; // root pages.module.ts / index.ts
      const sourceSub = parts[0];
      const sourceTier = SUBMODULE_TIERS[sourceSub];
      if (sourceTier === undefined) continue;

      const specs = extractModuleSpecifiers(fs.readFileSync(file, 'utf8'));
      for (const spec of specs) {
        let targetSub: string | null = null;
        let isDeep = false;

        const aliasMatch = /^@\/modules\/pages\/([^/]+)(?:\/(.+))?$/.exec(spec);
        if (aliasMatch) {
          targetSub = aliasMatch[1];
          isDeep = Boolean(aliasMatch[2] && aliasMatch[2] !== 'index');
        } else if (spec.startsWith('.')) {
          const resolved = path.resolve(path.dirname(file), spec);
          const resolvedRel = path
            .relative(PAGES_ROOT, resolved)
            .replace(/\\/g, '/');
          if (!resolvedRel.startsWith('..')) {
            const targetParts = resolvedRel.split('/');
            targetSub = targetParts[0];
            isDeep = targetParts.length > 1 && targetParts[1] !== 'index';
          }
        }

        if (!targetSub || targetSub === sourceSub) continue;
        const targetTier = SUBMODULE_TIERS[targetSub];
        if (targetTier === undefined) continue;

        if (isDeep) {
          deepImportViolations.push(`${rel} -> ${spec}`);
        }
        if (targetTier >= sourceTier) {
          tierViolations.push(
            `${rel} (tier ${sourceTier}) -> ${targetSub} (tier ${targetTier}) via ${spec}`,
          );
        }
      }
    }

    expect(deepImportViolations).toEqual([]);
    expect(tierViolations).toEqual([]);
  });
});
