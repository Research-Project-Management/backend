import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { ZoteroModule } from '@/modules/integrations/zotero/zotero.module';
import { ZoteroService } from '@/modules/integrations/zotero/zotero.service';
import { SyncModule } from '@/modules/library/sync/sync.module';
import { SYNC_PORT } from '@/modules/library/sync/ports/sync.port';
import { SyncService } from '@/modules/library/sync/sync.service';
import { TransactionService } from '@/modules/library/sync/services/transaction.service';

describe('Architecture & Integration Boundary Enforcement (ADR-0007)', () => {
  const backendRoot = path.resolve(__dirname, '../../../');
  const srcRoot = path.join(backendRoot, 'src');
  const libraryRoot = path.join(srcRoot, 'modules/library');
  const integrationsRoot = path.join(srcRoot, 'modules/integrations');

  function getAllFiles(dir: string, ext = '.ts'): string[] {
    const files: string[] = [];
    if (!fs.existsSync(dir)) return files;

    const list = fs.readdirSync(dir);
    for (const item of list) {
      const fullPath = path.join(dir, item);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        files.push(...getAllFiles(fullPath, ext));
      } else if (fullPath.endsWith(ext) && !fullPath.endsWith('.d.ts')) {
        files.push(fullPath);
      }
    }
    return files;
  }

  describe('Rule 1: Library Bounded Context Isolation', () => {
    it('strictly forbids any import from integrations into library modules', () => {
      const libraryFiles = getAllFiles(libraryRoot);
      expect(libraryFiles.length).toBeGreaterThan(0);

      const forbiddenImports: Array<{ file: string; line: string }> = [];

      for (const file of libraryFiles) {
        const content = fs.readFileSync(file, 'utf-8');
        const lines = content.split('\n');

        lines.forEach((line, index) => {
          if (
            line.includes('from') &&
            (line.includes('/integrations/') ||
              line.includes('@/modules/integrations') ||
              line.includes('../../integrations') ||
              line.includes('../../../integrations') ||
              line.includes('modules/integrations'))
          ) {
            forbiddenImports.push({
              file: path.relative(srcRoot, file),
              line: `L${index + 1}: ${line.trim()}`,
            });
          }
        });
      }

      expect(forbiddenImports).toEqual([]);
    });
  });

  describe('Rule 2: External Integrations Repository Seam', () => {
    it('strictly forbids integrations from directly importing library repositories', () => {
      const integrationFiles = getAllFiles(integrationsRoot);
      expect(integrationFiles.length).toBeGreaterThan(0);

      const forbiddenRepoImports: Array<{ file: string; line: string }> = [];

      for (const file of integrationFiles) {
        const content = fs.readFileSync(file, 'utf-8');
        const lines = content.split('\n');

        lines.forEach((line, index) => {
          if (
            line.includes('from') &&
            line.includes('/library/') &&
            (line.includes('.repository') ||
              line.includes('/repositories/') ||
              line.includes('Repository'))
          ) {
            forbiddenRepoImports.push({
              file: path.relative(srcRoot, file),
              line: `L${index + 1}: ${line.trim()}`,
            });
          }
        });
      }

      expect(forbiddenRepoImports).toEqual([]);
    });
  });

  describe('Rule 3: Zotero Module Public Surface Constraint', () => {
    it('exports ONLY ZoteroService as its public interface', () => {
      const exports = Reflect.getMetadata('exports', ZoteroModule) || [];
      expect(exports).toEqual([ZoteroService]);
    });
  });

  describe('Rule 4: Sync Module Public Surface Constraint', () => {
    it('exports strictly SYNC_PORT, SyncService, and TransactionService', () => {
      const exports = Reflect.getMetadata('exports', SyncModule) || [];
      expect(exports).toEqual([SYNC_PORT, SyncService, TransactionService]);
    });
  });

  describe('Rule 5: Prohibited Legacy / Stale Top-Level Directories', () => {
    it('ensures no prohibited legacy top-level directory names exist in library', () => {
      const prohibitedTopLevel = ['curation', 'legacy', 'tmp'];
      const libraryEntries = fs.readdirSync(libraryRoot);

      for (const forbidden of prohibitedTopLevel) {
        expect(libraryEntries).not.toContain(forbidden);
      }
    });
  });
});
