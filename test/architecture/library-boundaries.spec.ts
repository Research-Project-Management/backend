import * as fs from 'fs';
import * as path from 'path';

function getFilesRecursively(
  dir: string,
  predicate: (fileName: string) => boolean,
): string[] {
  let results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(getFilesRecursively(fullPath, predicate));
    } else if (entry.isFile() && predicate(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

describe('Library Architecture Boundaries (T007)', () => {
  const rootSrcDir = path.resolve(__dirname, '../../src');
  const libraryDir = path.join(rootSrcDir, 'modules/library');

  it('Rule 1: Library modules must never import from Integrations modules', () => {
    const allLibraryTsFiles = getFilesRecursively(libraryDir, (f) =>
      f.endsWith('.ts'),
    );

    const violations: { file: string; importStatement: string }[] = [];

    for (const file of allLibraryTsFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      for (const line of lines) {
        if (
          line.match(
            /from\s+['"].*\/modules\/integrations\/.*['"]|from\s+['"]@\/modules\/integrations\/.*['"]/,
          )
        ) {
          violations.push({
            file: path.relative(rootSrcDir, file),
            importStatement: line.trim(),
          });
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('Rule 2: Domain types and ports must remain pure and free from framework/ORM dependencies', () => {
    const typeAndPortFiles = getFilesRecursively(
      libraryDir,
      (f) =>
        (f.endsWith('.types.ts') || f.endsWith('.port.ts')) &&
        !f.endsWith('.spec.ts'),
    );

    const forbiddenPackages = [
      '@nestjs/common',
      '@nestjs/core',
      'fastify',
      '@fastify',
      'pg',
      'mysql2',
    ];

    const violations: { file: string; forbiddenImport: string }[] = [];

    for (const file of typeAndPortFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      for (const line of lines) {
        for (const pkg of forbiddenPackages) {
          const regex = new RegExp(`from\\s+['"]${pkg}(\\/.*)?['"]`);
          if (regex.test(line)) {
            violations.push({
              file: path.relative(rootSrcDir, file),
              forbiddenImport: line.trim(),
            });
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('Rule 3: Application port contracts must export runtime Symbol DI tokens', () => {
    const portFiles = getFilesRecursively(libraryDir, (f) =>
      f.endsWith('.port.ts'),
    );

    const missingSymbolTokens: string[] = [];

    for (const file of portFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      const hasSymbolExport =
        /export\s+const\s+[A-Z0-9_]+_PORT\s*=\s*Symbol\(/.test(content);
      if (!hasSymbolExport) {
        missingSymbolTokens.push(path.relative(rootSrcDir, file));
      }
    }

    expect(missingSymbolTokens).toEqual([]);
  });

  it('Rule 4: DTO classes must never import PrismaService or direct ORM handles', () => {
    const dtoFiles = getFilesRecursively(libraryDir, (f) =>
      f.endsWith('.dto.ts'),
    );

    const violations: { file: string; importLine: string }[] = [];

    for (const file of dtoFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      for (const line of lines) {
        if (
          line.includes('PrismaService') &&
          (line.startsWith('import') || line.includes('from'))
        ) {
          violations.push({
            file: path.relative(rootSrcDir, file),
            importLine: line.trim(),
          });
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('Rule 5: Feature modules must only export public Services, Ports, and Providers (T045/T046)', () => {
    const moduleFiles = getFilesRecursively(
      libraryDir,
      (f) => f.endsWith('.module.ts') && f !== 'library.module.ts',
    );

    const forbiddenExportPatterns = [
      /Repository$/,
      /PrismaService/,
    ];

    const violations: { file: string; forbiddenExport: string }[] = [];

    for (const file of moduleFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      const exportsMatch = content.match(/exports\s*:\s*\[([\s\S]*?)\]/);
      if (exportsMatch && exportsMatch[1]) {
        const exportedTokens = exportsMatch[1]
          .split(',')
          .map((t) => t.trim())
          .filter((t) => t.length > 0);

        for (const token of exportedTokens) {
          for (const pattern of forbiddenExportPatterns) {
            if (pattern.test(token) && token !== 'IdempotencyRepository') {
              violations.push({
                file: path.relative(rootSrcDir, file),
                forbiddenExport: token,
              });
            }
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
