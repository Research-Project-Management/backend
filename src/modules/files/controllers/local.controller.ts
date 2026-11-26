import {
  Controller,
  Get,
  Put,
  Query,
  Req,
  Res,
  Inject,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import * as path from 'path';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Readable } from 'node:stream';
import { BypassEnvelope } from '@/core';
import { STORAGE_ADAPTER } from '../files.constant';
import { ByteRange } from '../domain/storage.vo';
import { IStorageAdapter } from '../types/adapter.type';
import { LocalStorageAdapter } from '../adapters/local.adapter';
import { applyBinaryHeaders } from './http.helper';

@ApiTags('Files')
@Controller('api/v1/files')
@BypassEnvelope()
export class LocalFilesController {
  constructor(
    @Inject(STORAGE_ADAPTER) private readonly adapter: IStorageAdapter,
  ) {}

  private requireLocalAdapter(): LocalStorageAdapter {
    if (!(this.adapter instanceof LocalStorageAdapter)) {
      throw new NotFoundException('Local transfer routes are disabled');
    }
    return this.adapter;
  }

  private extractPayload(req: FastifyRequest): Buffer | Readable {
    const body = req.body;
    if (Buffer.isBuffer(body)) return body;
    if (
      body &&
      typeof body === 'object' &&
      typeof (body as Readable).pipe === 'function'
    ) {
      return body as Readable;
    }
    if (typeof body === 'string') {
      return Buffer.from(body, 'utf8');
    }
    if (body !== undefined && body !== null) {
      return Buffer.from(JSON.stringify(body), 'utf8');
    }
    return req.raw;
  }

  @Put('local-upload')
  @ApiOperation({ summary: 'Signed local disk presigned PUT endpoint' })
  async putLocalObject(
    @Query('key') key: string,
    @Query('expires') expiresStr: string,
    @Query('sig') sig: string,
    @Query('sha256') sha256: string | undefined,
    @Req() req: FastifyRequest,
  ) {
    const localAdapter = this.requireLocalAdapter();
    if (!key || !expiresStr || !sig) {
      throw new BadRequestException('Missing signed upload parameters');
    }
    const expiresAt = Number(expiresStr);
    const resource = sha256 ? `${key}:sha256=${sha256}` : key;
    if (!localAdapter.verifyToken('put', resource, expiresAt, sig)) {
      throw new ForbiddenException('Invalid or expired upload signature');
    }

    await localAdapter.putVerified(key, this.extractPayload(req), sha256);
    return { ok: true };
  }

  @Put('local-upload-part')
  @ApiOperation({
    summary: 'Signed local disk multipart chunk upload endpoint',
  })
  async putLocalMultipartPart(
    @Query('key') key: string,
    @Query('uploadId') uploadId: string,
    @Query('part') partStr: string,
    @Query('expires') expiresStr: string,
    @Query('sig') sig: string,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
    const localAdapter = this.requireLocalAdapter();
    const partNumber = Number(partStr);
    if (
      !key ||
      !uploadId ||
      !Number.isInteger(partNumber) ||
      partNumber < 1 ||
      !expiresStr ||
      !sig
    ) {
      throw new BadRequestException('Invalid multipart upload parameters');
    }

    const expiresAt = Number(expiresStr);
    const resource = `${key}:${uploadId}:${partNumber}`;
    if (!localAdapter.verifyToken('part', resource, expiresAt, sig)) {
      throw new ForbiddenException('Invalid or expired part signature');
    }

    const { eTag } = await localAdapter.putPart(
      uploadId,
      partNumber,
      this.extractPayload(req),
    );
    res.header('ETag', `"${eTag}"`);
    res.header('Access-Control-Expose-Headers', 'ETag');
    return res.status(200).send({ partNumber, eTag });
  }

  @Get('local-download')
  @ApiOperation({ summary: 'Signed local disk presigned GET endpoint' })
  async getLocalObject(
    @Query('key') key: string,
    @Query('expires') expiresStr: string,
    @Query('sig') sig: string,
    @Query('filename') filename: string | undefined,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
    const localAdapter = this.requireLocalAdapter();
    if (!key || !expiresStr || !sig) {
      throw new BadRequestException('Missing signed download parameters');
    }
    const expiresAt = Number(expiresStr);
    if (!localAdapter.verifyToken('get', key, expiresAt, sig)) {
      throw new ForbiddenException('Invalid or expired download signature');
    }

    let meta;
    try {
      meta = await localAdapter.stat(key);
    } catch {
      throw new NotFoundException('Object not found');
    }

    const rangeHeader =
      typeof req.headers?.range === 'string' ? req.headers.range : undefined;
    const byteRange = ByteRange.parse(rangeHeader, meta.size);

    const streamRes = await localAdapter.getStream(
      key,
      byteRange ? { start: byteRange.start, end: byteRange.end } : undefined,
    );

    res.status(byteRange ? 206 : 200);
    applyBinaryHeaders(res, {
      mimeType: meta.mimeType || 'application/octet-stream',
      filename: filename || path.basename(key) || 'download',
      isDownload: Boolean(filename),
      contentLength: streamRes.contentLength,
      contentRange: streamRes.contentRange,
      cacheControl: 'private, max-age=300',
      varyHeader: 'Range',
    });

    return res.send(streamRes.stream);
  }
}
