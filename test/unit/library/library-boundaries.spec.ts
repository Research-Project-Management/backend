import * as fs from 'fs';
import * as path from 'path';

function collectTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTsFiles(fullPath, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      out.push(fullPath);
    }
  }
  return out;
}

describe('Library Module Import Boundaries', () => {
  const libraryRoot = path.resolve(__dirname, '../../../src/modules/library');
  const boundedContexts = [
    'catalog',
    'citation',
    'extraction',
    'ingestion',
    'search',
    'sync',
  ] as const;

  const files = collectTsFiles(libraryRoot).map((file) => {
    const content = fs.readFileSync(file, 'utf-8');
    return {
      relPath: path.relative(libraryRoot, file).replace(/\\/g, '/'),
      lines: content.split(/\r?\n/),
    };
  });

  it('keeps non-core bounded contexts isolated from direct sibling imports', () => {
    const violations: string[] = [];

    for (const { relPath, lines } of files) {
      const sourceCtx = boundedContexts.find((ctx) =>
        relPath.startsWith(`${ctx}/`),
      );
      if (!sourceCtx) continue;

      lines.forEach((line, idx) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
        for (const targetCtx of boundedContexts) {
          if (targetCtx === sourceCtx) continue;
          const peerImport = new RegExp(
            `(?:@/modules/library/${targetCtx}|\\.\\./${targetCtx}|\\.\\./\\.\\./${targetCtx})(?:/|['"])`,
          );
          if (peerImport.test(line)) {
            violations.push(`${relPath}:${idx + 1} -> ${trimmed}`);
          }
        }
      });
    }

    expect(violations).toEqual([]);
  });

  it('keeps core/domain, core/ports, and bounded-context domain layers free of infrastructure and upward imports', () => {
    const violations: string[] = [];

    for (const { relPath, lines } of files) {
      const isCorePure =
        relPath.startsWith('core/domain/') || relPath.startsWith('core/ports/');
      const isDomainFile = /(?:^|\/)domain\//.test(relPath);
      if (!isCorePure && !isDomainFile) continue;

      lines.forEach((line, idx) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;

        if (
          isCorePure &&
          (/from\s+['"]@\/modules\/library\/(catalog|citation|extraction|ingestion|search|sync)/.test(
            line,
          ) ||
            /from\s+['"]@nestjs\//.test(line))
        ) {
          violations.push(`${relPath}:${idx + 1} -> ${trimmed}`);
        }

        if (
          isDomainFile &&
          (/\bPrismaService\b/.test(line) ||
            /\bRedisCacheService\b/.test(line) ||
            /from\s+['"][^'"]*\/(repositories|controllers|services|dto)\//.test(
              line,
            ))
        ) {
          violations.push(`${relPath}:${idx + 1} -> ${trimmed}`);
        }
      });
    }

    expect(violations).toEqual([]);
  });
});
