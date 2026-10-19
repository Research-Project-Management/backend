/**
 * modules/manuscripts/clsi/domain/synctex.parser.ts
 * Pure in-process domain parser decompressing SyncTeX streams and resolving
 * forward/reverse coordinate mappings with indexed LRU caching.
 */

import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { promisify } from 'util';
import { ISyncTexProcessor, SyncPoint, ReverseSyncPoint } from './clsi-ports';

const gunzipAsync = promisify(zlib.gunzip);
const MAX_CACHE_ENTRIES = 6;

export interface SyncTexInputFile {
  tag: number;
  path: string;
}

export interface SyncTexRecord {
  tag: number;
  line: number;
  col: number;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ParsedSyncTexData {
  inputs: SyncTexInputFile[];
  records: SyncTexRecord[];
  recordsByTag: Map<number, SyncTexRecord[]>;
  recordsByPage: Map<number, SyncTexRecord[]>;
  unit: number;
}

export class SyncTexProcessor implements ISyncTexProcessor {
  private readonly lruCache = new Map<string, ParsedSyncTexData>();

  private getCacheKey(synctexText: string): string {
    if (synctexText.length > 2048) {
      // Fast fingerprint for large synctex texts avoiding expensive full-text sha256 on every lookup
      const head = synctexText.slice(0, 128);
      const tail = synctexText.slice(-128);
      const mid = synctexText.slice(
        Math.floor(synctexText.length / 2),
        Math.floor(synctexText.length / 2) + 64,
      );
      return `${synctexText.length}:${head}:${mid}:${tail}`;
    }
    return crypto
      .createHash('sha256')
      .update(synctexText, 'utf8')
      .digest('hex');
  }

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
    const cacheKey = this.getCacheKey(synctexText);
    const existing = this.lruCache.get(cacheKey);
    if (existing) {
      this.lruCache.delete(cacheKey);
      this.lruCache.set(cacheKey, existing);
      return existing;
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

      if (line.startsWith('{')) {
        const pageStr = line.slice(1).replace(/}.*$/, '').trim();
        const pageNum = parseInt(pageStr, 10);
        if (!isNaN(pageNum) && pageNum > 0) currentPage = pageNum;
        continue;
      }

      if (/^[xkhvg]\d+,\d+/.test(line)) {
        const typeMatch = line.match(
          /^[xkhvg](\d+),(\d+)(?:,(\d+))?:(-?\d+),(-?\d+)(?::(-?\d+),(-?\d+))?/,
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

          let tagList = recordsByTag.get(tag);
          if (!tagList) {
            tagList = [];
            recordsByTag.set(tag, tagList);
          }
          tagList.push(record);

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

    if (this.lruCache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = this.lruCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.lruCache.delete(oldestKey);
      }
    }
    this.lruCache.set(cacheKey, parsed);

    return parsed;
  }

  public forwardLookup(
    synctexText: string,
    file: string,
    line: number,
    _col?: number,
  ): SyncPoint | null {
    if (!synctexText) return null;
    const { inputs, records, recordsByTag, unit } =
      this.parseRecords(synctexText);
    if (records.length === 0) return null;

    const cleanFile = file
      .replace(/\\/g, '/')
      .replace(/^(\.\/)+/, '')
      .replace(/^\/+/, '');

    let matchedInput = inputs.find((inp) => {
      const cleanInp = inp.path
        .replace(/\\/g, '/')
        .replace(/^(\.\/)+/, '')
        .replace(/^\/+/, '');
      return (
        cleanInp === cleanFile ||
        cleanInp.endsWith(`/${cleanFile}`) ||
        cleanFile.endsWith(`/${cleanInp}`)
      );
    });

    if (!matchedInput) {
      const targetBasename = cleanFile.split('/').pop();
      matchedInput = inputs.find((inp) => {
        const cleanInp = inp.path
          .replace(/\\/g, '/')
          .replace(/^(\.\/)+/, '')
          .replace(/^\/+/, '');
        return cleanInp.split('/').pop() === targetBasename;
      });
    }
    const targetTag = matchedInput ? matchedInput.tag : null;

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
    const bestBlock = {
      width: Math.round(closestRecord.w * scaleFactor),
      height: Math.round(closestRecord.h * scaleFactor),
    };

    return {
      page: closestRecord.page,
      x: Math.round(closestRecord.x * scaleFactor),
      y: Math.round(closestRecord.y * scaleFactor),
      width: bestBlock.width > 10 ? bestBlock.width : 220,
      height: bestBlock.height > 2 ? bestBlock.height : 12,
      precision: minLineDiff === 0 ? 'exact' : 'approximate',
    };
  }

  public reverseLookup(
    synctexText: string,
    page: number,
    x: number,
    y: number,
  ): ReverseSyncPoint | null {
    if (!synctexText) return null;
    const { inputs, records, recordsByPage, unit } =
      this.parseRecords(synctexText);
    if (records.length === 0) return null;

    const scaleFactor = (unit / 65536) * 0.996264;
    const targetSpX = scaleFactor > 0 ? x / scaleFactor : x;
    const targetSpY = scaleFactor > 0 ? y / scaleFactor : y;

    const searchRecords = recordsByPage.get(page) || records;

    let closestRecord: SyncTexRecord | null = null;
    let minDistanceSq = Infinity;

    for (const record of searchRecords) {
      if (record.page !== page) continue;

      const spanWidth = Math.max(0, record.w);
      const minX = record.x;
      const maxX = record.x + spanWidth;
      const dx =
        targetSpX < minX
          ? minX - targetSpX
          : targetSpX > maxX
            ? targetSpX - maxX
            : 0;
      const dy = (record.y - targetSpY) * 4;
      const distSq = dx * dx + dy * dy;

      if (distSq < minDistanceSq) {
        minDistanceSq = distSq;
        closestRecord = record;
      }
    }

    if (!closestRecord) return null;

    const matchedInput = inputs.find((inp) => inp.tag === closestRecord?.tag);
    const rawFile = matchedInput ? matchedInput.path : 'main.tex';
    const resolvedFile = rawFile
      .replace(/\\/g, '/')
      .replace(/^(\.\/)+/, '')
      .replace(/^\/+/, '');

    return {
      file: resolvedFile,
      line: closestRecord.line,
      column: closestRecord.col,
      precision: 'coordinate_match',
    };
  }
}
