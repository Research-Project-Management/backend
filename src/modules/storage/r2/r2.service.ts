import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getErrorMessage } from '@/core/utils/error.util';

@Injectable()
export class R2Service {
  private readonly s3Client: S3Client;
  private readonly bucket: string;
  private readonly logger = new Logger(R2Service.name);

  constructor(private readonly configService: ConfigService) {
    const accountId = this.configService.get<string>('R2_ACCOUNT_ID') || '';
    const accessKeyId =
      this.configService.get<string>('R2_ACCESS_KEY_ID') || '';
    const secretAccessKey =
      this.configService.get<string>('R2_SECRET_ACCESS_KEY') || '';
    this.bucket =
      this.configService.get<string>('R2_BUCKET_NAME') || 'rpm-storage';

    const endpoint = accountId
      ? `https://${accountId}.r2.cloudflarestorage.com`
      : 'http://localhost:9000';

    this.s3Client = new S3Client({
      region: 'auto',
      endpoint,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });
  }

  async getPresignedUploadUrl(
    key: string,
    contentType = 'application/octet-stream',
    expiresIn = 3600,
  ) {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
    });
    const signedUrl = await getSignedUrl(this.s3Client, command, {
      expiresIn,
    });
    return { signedUrl, path: key, url: `/api/files/r2/${key}` };
  }

  async getPresignedDownloadUrl(key: string, expiresIn = 3600) {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });
    return getSignedUrl(this.s3Client, command, { expiresIn });
  }

  async uploadBuffer(
    key: string,
    buffer: Buffer,
    contentType = 'application/octet-stream',
  ) {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    });
    await this.s3Client.send(command);
    return { path: key, url: `/api/files/r2/${key}` };
  }

  async deleteObject(key: string) {
    const command = new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });
    await this.s3Client.send(command).catch((err: unknown) => {
      this.logger.warn(
        `Failed to delete object ${key}: ${getErrorMessage(err)}`,
      );
    });
  }

  async getObjectStream(key: string) {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });
    return this.s3Client.send(command);
  }
}
