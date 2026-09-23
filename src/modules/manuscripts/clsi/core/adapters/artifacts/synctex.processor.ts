/**
 * modules/manuscripts/clsi/core/adapters/artifacts/synctex.processor.ts
 * Decompresses SyncTeX data and resolves forward/reverse mappings between editor and PDF coordinates.
 * Includes indexed caching by file tag and page number for high-performance coordinate lookup on large documents.
 */

import * as zlib from 'zlib';
import { promisify } from 'util';
import {
  ISyncTexProcessor,
  SyncPoint,
  ReverseSyncPoint,
} from '../../ports/artifacts.port';

const gunzipAsync = promisify(zlib.gunzip);

interface SyncTexInputFile {
  tag: number;
  path: string;
}

interface SyncTexRecord {
  tag: number;
  line: number;
  col: number;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ParsedSyncTexData {
  inputs: SyncTexInputFile[];
  records: SyncTexRecord[];
  recordsByTag: Map<number, SyncTexRecord[]>;
  recordsByPage: Map<number, SyncTexRecord[]>;
  unit: number;
}

export class SyncTexProcessor implements ISyncTexProcessor {
  private cachedKey: string = '';
  private cachedData: ParsedSyncTexData | null = null;

  public async decompress(buffer: Buffer): Promise<string> {
    if (!buffer || buffer.length === 0) return '';
    const isGzip =
      buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
    if (isGzip) {
      try {
        const decompressed = await gunzipAsync(buffer);
        return decompressed.toString('utf8');
      } catch {
        return '';
      }
    }
    return buffer.toString('utf8');
  }

  public parseRecords(synctexText: string): ParsedSyncTexData {
    // Check in-memory cache for repeated lookups on identical text
    if (this.cachedData && this.cachedKey === synctexText) {
      return this.cachedData;
    }

    const lines = synctexText.split('\n');
    const inputs: SyncTexInputFile[] = [];
    const records: SyncTexRecord[] = [];
    const recordsByTag = new Map<number, SyncTexRecord[]>();
    const recordsByPage = new Map<number, SyncTexRecord[]>();
    let unit = 1;
    let currentPage = 1;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      if (line.startsWith('Unit:')) {
        const parsedUnit = parseFloat(line.substring(5).trim());
        if (!isNaN(parsedUnit) && parsedUnit > 0) unit = parsedUnit;
        continue;
      }

      if (line.startsWith('Input:')) {
        const match = line.match(/^Input:(\d+):(.+)$/);
        if (match && match[1] && match[2]) {
          inputs.push({ tag: parseInt(match[1], 10), path: match[2].trim() });
        }
        continue;
      }

      // SyncTeX page sheet identifier: {<sheet_num>} or {<sheet_num>
      if (line.startsWith('{')) {
        const pageStr = line.slice(1).replace(/}.*$/, '').trim();
        const pageNum = parseInt(pageStr, 10);
        if (!isNaN(pageNum) && pageNum > 0) currentPage = pageNum;
        continue;
      }

      if (/^[xkhvg]\d+,\d+/.test(line)) {
        const typeMatch = line.match(
          /^[xkhvg](\d+),(\d+)(?:,(\d+))?:(-?\d+),(-?\d+)(?::(-?\d+),(-?\d+))?/
        );
        if (
          typeMatch &&
          typeMatch[1] &&
          typeMatch[2] &&
          typeMatch[4] &&
          typeMatch[5]
        ) {
          const tag = parseInt(typeMatch[1], 10);
          const lineNum = parseInt(typeMatch[2], 10);
          const col = typeMatch[3] ? parseInt(typeMatch[3], 10) : 0;
          const x = parseInt(typeMatch[4], 10);
          const y = parseInt(typeMatch[5], 10);
          const w = typeMatch[6] ? parseInt(typeMatch[6], 10) : 0;
          const h = typeMatch[7] ? parseInt(typeMatch[7], 10) : 0;

          const record: SyncTexRecord = {
            tag,
            line: lineNum,
            col,
            page: currentPage,
            x,
            y,
            w,
            h,
          };

          records.push(record);

          // Index by Tag for fast forward lookup
          let tagList = recordsByTag.get(tag);
          if (!tagList) {
            tagList = [];
            recordsByTag.set(tag, tagList);
          }
          tagList.push(record);

          // Index by Page for fast reverse lookup
          let pageList = recordsByPage.get(currentPage);
          if (!pageList) {
            pageList = [];
            recordsByPage.set(currentPage, pageList);
          }
          pageList.push(record);
        }
      }
    }

    const parsed: ParsedSyncTexData = {
      inputs,
      records,
      recordsByTag,
      recordsByPage,
      unit,
    };

    // Store in cache
    this.cachedKey = synctexText;
    this.cachedData = parsed;

    return parsed;
  }

  public forwardLookup(
    synctexText: string,
    file: string,
    line: number,
    _col?: number
  ): SyncPoint | null {
    if (!synctexText) return null;
    const { inputs, records, recordsByTag, unit } = this.parseRecords(synctexText);
    if (records.length === 0) return null;

    const matchedInput = inputs.find(
      (inp) =>
        inp.path === file ||
        inp.path.endsWith(`/${file}`) ||
        inp.path.endsWith(`\\${file}`)
    );
    const targetTag = matchedInput ? matchedInput.tag : null;

    // Use tag-indexed records if available, otherwise fallback to full records
    const searchRecords =
      targetTag !== null && recordsByTag.has(targetTag)
        ? recordsByTag.get(targetTag)!
        : records;

    let closestRecord: SyncTexRecord | null = null;
    let minLineDiff = Infinity;

    for (const record of searchRecords) {
      if (targetTag !== null && record.tag !== targetTag) continue;
      const diff = Math.abs(record.line - line);
      if (diff < minLineDiff) {
        minLineDiff = diff;
        closestRecord = record;
        if (diff === 0) break;
      }
    }

    if (!closestRecord || minLineDiff > 50) return null;

    const scaleFactor = (unit / 65536) * 0.996264;

    return {
      page: closestRecord.page,
      x: Math.round(closestRecord.x * scaleFactor),
      y: Math.round(closestRecord.y * scaleFactor),
      width: Math.max(Math.round(closestRecord.w * scaleFactor), 300),
      height: Math.max(Math.round(closestRecord.h * scaleFactor), 12),
      precision: minLineDiff === 0 ? 'exact' : 'approximate',
    };
  }

  public reverseLookup(
    synctexText: string,
    page: number,
    x: number,
    y: number
  ): ReverseSyncPoint | null {
    if (!synctexText) return null;
    const { inputs, records, recordsByPage, unit } = this.parseRecords(synctexText);
    if (records.length === 0) return null;

    const scaleFactor = (unit / 65536) * 0.996264;
    const targetSpX = scaleFactor > 0 ? x / scaleFactor : x;
    const targetSpY = scaleFactor > 0 ? y / scaleFactor : y;

    // Use page-indexed records for high performance
    const searchRecords = recordsByPage.get(page) || records;

    let closestRecord: SyncTexRecord | null = null;
    let minDistanceSq = Infinity;

    for (const record of searchRecords) {
      if (record.page !== page) continue;

      const dx = record.x - targetSpX;
      const dy = record.y - targetSpY;
      const distSq = dx * dx + dy * dy;

      if (distSq < minDistanceSq) {
        minDistanceSq = distSq;
        closestRecord = record;
      }
    }

    if (!closestRecord) return null;

    const matchedInput = inputs.find((inp) => inp.tag === closestRecord?.tag);
    const resolvedFile = matchedInput ? matchedInput.path : 'main.tex';

    return {
      file: resolvedFile,
      line: closestRecord.line,
      column: closestRecord.col,
      precision: 'coordinate_match',
    };
  }
}
