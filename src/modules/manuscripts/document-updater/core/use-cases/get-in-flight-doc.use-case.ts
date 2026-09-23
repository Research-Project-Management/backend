/**
 * document-updater/core/use-cases/get-in-flight-doc.use-case.ts
 * Application Use Case for querying the active in-flight buffer or loading from docstore baseline.
 */

import { Injectable } from '@nestjs/common';
import { IInFlightStorePort } from '../ports/in-flight-store.port';
import { IDocstoreWriterPort } from '../ports/docstore-writer.port';
import { InFlightDoc } from '../domain/entities/in-flight-doc.entity';
import { DocumentVersionVo } from '../domain/value-objects/document-version.vo';
import { InFlightNotFoundException } from '../domain/exceptions/in-flight-not-found.exception';

export interface GetInFlightDocInput {
  projectId: string;
  docId: string;
}

export interface GetInFlightDocOutput {
  doc: InFlightDoc;
  isBuffered: boolean;
}

@Injectable()
export class GetInFlightDocUseCase {
  constructor(
    private readonly inFlightStore: IInFlightStorePort,
    private readonly docstoreWriter: IDocstoreWriterPort,
  ) {}

  public async execute(input: GetInFlightDocInput): Promise<GetInFlightDocOutput> {
    const { projectId, docId } = input;

    // 1. Check in-flight store (Redis/Memory)
    const activeDoc = await this.inFlightStore.get(projectId, docId);
    if (activeDoc) {
      return {
        doc: activeDoc,
        isBuffered: true,
      };
    }

    // 2. Fallback to docstore persistent baseline
    const baseDoc = await this.docstoreWriter.fetchBaseDoc(projectId, docId);
    if (!baseDoc) {
      throw new InFlightNotFoundException(docId, projectId);
    }

    const doc = InFlightDoc.create({
      docId,
      projectId,
      lines: baseDoc.lines,
      version: DocumentVersionVo.initial(baseDoc.rev),
    });

    return {
      doc,
      isBuffered: false,
    };
  }
}
