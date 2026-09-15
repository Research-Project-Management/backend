import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ForwardSyncDto,
  ReverseSyncDto,
  SyncPoint,
  ReverseSyncPoint,
} from './dto/synctex.dto';
import { tryCatch, getErrorMessage } from '@/core/utils/error.util';

@Injectable()
export class SynctexService {
  private readonly latexUrl: string;
  private readonly logger = new Logger(SynctexService.name);

  constructor(private readonly configService: ConfigService) {
    this.latexUrl =
      this.configService.get<string>('LATEX_URL') || 'http://localhost:2918';
  }

  /**
   * Forward SyncTeX: Map (file, line, column) in LaTeX source -> (page, x, y, width, height) in PDF.
   */
  async forwardSync(dto: ForwardSyncDto): Promise<{
    success: boolean;
    result?: SyncPoint;
    fallback?: boolean;
    error?: string;
  }> {
    const payload = {
      project_id: dto.projectId || dto.pageId || 'default',
      file: dto.file,
      line: dto.line,
      column: dto.column ?? 0,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const fetchResult = await tryCatch(
      fetch(`${this.latexUrl}/synctex/forward`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout)),
    );

    if (fetchResult.ok && fetchResult.value.ok) {
      const json = await fetchResult.value.json();
      if (json && json.success && json.result) {
        return {
          success: true,
          result: {
            page: json.result.page || 1,
            x: json.result.x || 72,
            y: json.result.y || 72,
            width: json.result.width || 450,
            height: json.result.height || 14,
          },
        };
      }
    }

    this.logger.debug(
      `SyncTeX forward compiler lookup failed, using calculated heuristic estimation`,
    );

    // Heuristic fallback: approx 55 lines per standard LaTeX A4 page, 14pt per line
    const approxLinesPerPage = 50;
    const estPage = Math.max(1, Math.ceil(dto.line / approxLinesPerPage));
    const lineInPage = (dto.line - 1) % approxLinesPerPage;
    const estY = Math.min(750, 100 + lineInPage * 13.5);

    return {
      success: true,
      result: {
        page: estPage,
        x: 72,
        y: estY,
        width: 450,
        height: 14,
      },
      fallback: true,
    };
  }

  /**
   * Reverse SyncTeX: Map (page, x, y) in rendered PDF -> (file, line, column) in LaTeX source.
   */
  async reverseSync(dto: ReverseSyncDto): Promise<{
    success: boolean;
    result?: ReverseSyncPoint;
    fallback?: boolean;
    error?: string;
  }> {
    const payload = {
      project_id: dto.projectId || dto.pageId || 'default',
      page: dto.page,
      x: dto.x,
      y: dto.y,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const fetchResult = await tryCatch(
      fetch(`${this.latexUrl}/synctex/reverse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout)),
    );

    if (fetchResult.ok && fetchResult.value.ok) {
      const json = await fetchResult.value.json();
      if (json && json.success && json.result) {
        return {
          success: true,
          result: {
            file: json.result.file || 'main.tex',
            line: json.result.line || 1,
            column: json.result.column || 0,
          },
        };
      }
    }

    // Heuristic fallback: reverse calculation from PDF page & y offset
    const approxLinesPerPage = 50;
    const relativeY = Math.max(0, dto.y - 100);
    const lineInPage = Math.floor(relativeY / 13.5);
    const estLine = Math.max(
      1,
      (dto.page - 1) * approxLinesPerPage + lineInPage + 1,
    );

    return {
      success: true,
      result: {
        file: 'main.tex',
        line: estLine,
        column: 0,
      },
      fallback: true,
    };
  }
}
