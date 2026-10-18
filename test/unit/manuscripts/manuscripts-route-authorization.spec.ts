import {
  ROLES_KEY,
  MIN_ROLE_KEY,
} from '@/modules/project/access/decorators/require-role.decorator';
import { PERMISSIONS_KEY } from '@/modules/project/access/decorators/require-permission.decorator';
import { REQUIRE_OPERATOR_KEY } from '@/modules/project/access/decorators/require-operator.decorator';
import { NO_PROJECT_CONTEXT_KEY } from '@/modules/project/access/decorators/no-project-context.decorator';

// Import Manuscript Controllers
import {
  CitationsController,
  CitationsUtilityController,
} from '@/modules/manuscripts/citations/citations.controller';
import { ClsiController } from '@/modules/manuscripts/clsi/clsi.controller';
import { DiagnosticsController } from '@/modules/manuscripts/diagnostics/diagnostics.controller';
import { DocstoreController } from '@/modules/manuscripts/docstore/docstore.controller';
import { PagesBridgeController } from '@/modules/manuscripts/docstore/pages-bridge.controller';
import { PagesDocController } from '@/modules/manuscripts/docstore/controllers/pages-doc.controller';
import { PagesHistoryExportController } from '@/modules/manuscripts/docstore/controllers/pages-history-export.controller';
import { PagesReviewController } from '@/modules/manuscripts/docstore/controllers/pages-review.controller';
import { PagesSearchPresenceController } from '@/modules/manuscripts/docstore/controllers/pages-search-presence.controller';
import { DocumentUpdaterController } from '@/modules/manuscripts/document-updater/document-updater.controller';
import { ExportImportController } from '@/modules/manuscripts/export-import/export-import.controller';
import { FilestoreController } from '@/modules/manuscripts/filestore/filestore.controller';
import { GitBridgeController } from '@/modules/manuscripts/git-bridge/git-bridge.controller';
import { LinkedFilesController } from '@/modules/manuscripts/linked-files/linked-files.controller';
import { ProjectHistoryController } from '@/modules/manuscripts/project-history/project-history.controller';
import {
  SpellingController,
  SpellingUtilityController,
} from '@/modules/manuscripts/spelling/spelling.controller';
import { StructureController } from '@/modules/manuscripts/structure/structure.controller';
import {
  TemplatesController,
  OverleafTemplatesParityController,
} from '@/modules/manuscripts/templates/templates.controller';
import { TrackChangesController } from '@/modules/manuscripts/track-changes/track-changes.controller';

const MANUSCRIPT_CONTROLLERS = [
  CitationsController,
  CitationsUtilityController,
  ClsiController,
  DiagnosticsController,
  DocstoreController,
  PagesBridgeController,
  PagesDocController,
  PagesHistoryExportController,
  PagesReviewController,
  PagesSearchPresenceController,
  DocumentUpdaterController,
  ExportImportController,
  FilestoreController,
  GitBridgeController,
  LinkedFilesController,
  ProjectHistoryController,
  SpellingController,
  SpellingUtilityController,
  StructureController,
  TemplatesController,
  OverleafTemplatesParityController,
  TrackChangesController,
];

// Zero-tolerance allowlist: all manuscript routes must have an explicit access declaration.
export const KNOWN_GAPS_ALLOWLIST: string[] = [];

describe('Manuscripts Route Authorization Inventory', () => {
  it('should reflect over all manuscript controllers and verify every handler has an explicit access declaration (0 undeclared routes)', () => {
    const unannotatedRoutes: string[] = [];

    for (const controller of MANUSCRIPT_CONTROLLERS) {
      const controllerName = controller.name;
      const classRoles =
        Reflect.getMetadata(ROLES_KEY, controller) ||
        Reflect.getMetadata(MIN_ROLE_KEY, controller);
      const classPerms = Reflect.getMetadata(PERMISSIONS_KEY, controller);
      const classOperator = Reflect.getMetadata(
        REQUIRE_OPERATOR_KEY,
        controller,
      );
      const classNoContext = Reflect.getMetadata(
        NO_PROJECT_CONTEXT_KEY,
        controller,
      );

      const prototype = controller.prototype as Record<string, any>;
      const methodNames = Object.getOwnPropertyNames(prototype).filter(
        (prop) =>
          prop !== 'constructor' && typeof prototype[prop] === 'function',
      );

      for (const methodName of methodNames) {
        const handler = prototype[methodName];
        const isHttpRoute =
          Reflect.hasMetadata('path', handler) ||
          Reflect.hasMetadata('method', handler);

        if (!isHttpRoute) continue;

        const methodRoles =
          Reflect.getMetadata(ROLES_KEY, handler) ||
          Reflect.getMetadata(MIN_ROLE_KEY, handler);
        const methodPerms = Reflect.getMetadata(PERMISSIONS_KEY, handler);
        const methodOperator = Reflect.getMetadata(
          REQUIRE_OPERATOR_KEY,
          handler,
        );
        const methodNoContext = Reflect.getMetadata(
          NO_PROJECT_CONTEXT_KEY,
          handler,
        );

        const hasEffectiveAccess = !!(
          classRoles ||
          classPerms ||
          classOperator ||
          classNoContext ||
          methodRoles ||
          methodPerms ||
          methodOperator ||
          methodNoContext
        );

        const routeKey = `${controllerName}.${methodName}`;
        if (!hasEffectiveAccess) {
          unannotatedRoutes.push(routeKey);
        }
      }
    }

    // Verify all unannotated routes are covered by KNOWN_GAPS_ALLOWLIST
    const unexpectedGaps = unannotatedRoutes.filter(
      (route) => !KNOWN_GAPS_ALLOWLIST.includes(route),
    );

    expect(unexpectedGaps).toEqual([]);
  });
});
