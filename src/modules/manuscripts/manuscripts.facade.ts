/**
 * modules/manuscripts/manuscripts.facade.ts
 * Root Facade providing a unified programmatic entrypoint into the Manuscripts subsystem.
 */

import { Injectable } from '@nestjs/common';
import { DocstoreService } from './docstore/docstore.service';
import { StructureService } from './structure/structure.service';
import { FilestoreService } from './filestore/filestore.service';
import { ClsiService } from './clsi/services/clsi.service';
import { ProjectHistoryService } from './project-history/project-history.service';
import { TrackChangesService } from './track-changes/track-changes.service';
import { CitationsService } from './citations/citations.service';

@Injectable()
export class ManuscriptsFacade {
  constructor(
    public readonly docstore: DocstoreService,
    public readonly structure: StructureService,
    public readonly filestore: FilestoreService,
    public readonly clsi: ClsiService,
    public readonly projectHistory: ProjectHistoryService,
    public readonly trackChanges: TrackChangesService,
    public readonly citations: CitationsService,
  ) {}
}
