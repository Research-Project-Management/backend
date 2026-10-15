/**
 * project-history/core/adapters/engine/myers-diff-engine.adapter.ts
 * Driven Adapter implementing IDiffEnginePort by delegating to pure MyersDiffEngine.
 */

import { Injectable } from '@nestjs/common';
import {
  IDiffEnginePort,
  TextDiffResult,
} from '@/modules/manuscripts/project-history/core/ports/diff-engine.port';
import { Snapshot } from '@/modules/manuscripts/project-history/core/domain/entities/snapshot.entity';
import { FileDiffVo } from '@/modules/manuscripts/project-history/core/domain/value-objects/file-diff.vo';
import { MyersDiffEngine } from '../../../domain/myers-diff.engine';

@Injectable()
export class MyersDiffEngineAdapter extends IDiffEnginePort {
  private readonly engine = new MyersDiffEngine();

  public compareSnapshots(
    baseSnapshot: Snapshot,
    targetSnapshot: Snapshot,
  ): FileDiffVo[] {
    return this.engine.compareSnapshots(baseSnapshot, targetSnapshot);
  }

  public diffText(oldLines: string[], newLines: string[]): TextDiffResult {
    return this.engine.diffText(oldLines, newLines);
  }
}
