/**
 * modules/pages/page/types/page.types.ts
 * Canonical parameter and context types for the Page management module.
 */

import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '@/core';
import { type IFilesPort } from '@/modules/files/types/files.type';
import { LiveCollaborationPort } from '../../core/ports/live-collaboration.port';
import { PageDomainEventBus } from '../../core/events/event-bus.service';
import { DocstoreService } from '../../docstore/docstore.service';
import { ScopeRepository } from '../../docstore/repositories/scope.repository';
import type { PageRepository } from '../page.repository';

export interface PageDocRanges {
  labels?: Array<{ id: string; name?: string; color?: string }>;
  labelIds?: string[];
  status?: string;
  description?: string;
  [key: string]: unknown;
}

export interface UpdatePageContentParams {
  content?: string;
  lines?: string[];
  title?: string;
  version?: number;
  expectedRev?: number;
  expectedVersion?: number;
  status?: 'draft' | 'published' | 'archived';
  description?: string;
}

export interface PageLifecycleContext {
  readonly prisma: PrismaService;
  readonly pageRepo?: PageRepository;
  readonly docstoreService: DocstoreService;
  readonly pageScopeRepo: ScopeRepository;
  readonly liveCollab: LiveCollaborationPort;
  readonly domainEventBus: PageDomainEventBus;
  readonly logger: Logger;
  readonly eventEmitter?: EventEmitter2;
  readonly filesPort?: IFilesPort;
}

export interface CreatePageFileParams {
  title?: string;
  name?: string;
  content?: string;
}

export interface ImportFromProjectParams {
  sourceProjectId?: string;
  sourceFileId: string;
  targetName?: string;
  targetPath?: string;
  parentPageId?: string;
}

export interface PageFilesTransferContext {
  readonly prisma: PrismaService;
  readonly pageRepo?: PageRepository;
  readonly docstoreService: DocstoreService;
  readonly liveCollab: LiveCollaborationPort;
  readonly eventEmitter?: EventEmitter2;
  readonly filesPort?: IFilesPort;
}
