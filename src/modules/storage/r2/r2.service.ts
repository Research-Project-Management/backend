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
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class R2Service {
  private readonly s3Client: S3Client;
  private readonly bucket: string;
  private readonly logger = new Logger(R2Service.name);

  constructor(private readonly configService: ConfigService) {
    const apiUrl =
      this.configService.get<string>('R2_API_URL') ||
      process.env.R2_API_URL ||
      '';
    const accountId =
      this.configService.get<string>('R2_ACCOUNT_ID') ||
      process.env.R2_ACCOUNT_ID ||
      '';
    const accessKeyId =
      this.configService.get<string>('R2_ACCESS_KEY') ||
      process.env.R2_ACCESS_KEY ||
      this.configService.get<string>('R2_ACCESS_KEY_ID') ||
      process.env.R2_ACCESS_KEY_ID ||
      '';
    const secretAccessKey =
      this.configService.get<string>('R2_SECRET_KEY') ||
      process.env.R2_SECRET_KEY ||
      this.configService.get<string>('R2_SECRET_ACCESS_KEY') ||
      process.env.R2_SECRET_ACCESS_KEY ||
      '';
    this.bucket =
      this.configService.get<string>('R2_BUCKET_NAME') ||
      process.env.R2_BUCKET_NAME ||
      'flux';

    const endpoint = apiUrl
      ? apiUrl
      : accountId
        ? `https://${accountId}.r2.cloudflarestorage.com`
        : 'http://localhost:9000';

    this.logger.log(
      `R2 initialized with endpoint: ${endpoint}, bucket: ${this.bucket}`,
    );

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

  private getLocalFilePath(key: string): string {
    const cleanKey = key.startsWith('/') ? key.slice(1) : key;
    if (cleanKey.startsWith('uploads/') || cleanKey.startsWith('uploads\\')) {
      return path.join(process.cwd(), cleanKey);
    }
    return path.join(process.cwd(), 'uploads', cleanKey);
  }

  async uploadBuffer(
    key: string,
    buffer: Buffer,
    contentType = 'application/octet-stream',
  ) {
    try {
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      });
      await this.s3Client.send(command);
      return { path: key, url: `/api/files/r2/${key}` };
    } catch (s3Err) {
      this.logger.warn(
        `R2 upload failed (${getErrorMessage(s3Err)}), fallback saving to local storage`,
      );
      try {
        const filePath = this.getLocalFilePath(key);
        const parentDir = path.dirname(filePath);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }
        fs.writeFileSync(filePath, buffer);
        return { path: key, url: `/api/files/r2/${key}` };
      } catch (localErr) {
        this.logger.error(
          `Local fallback also failed: ${getErrorMessage(localErr)}`,
        );
        throw s3Err;
      }
    }
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

    const filePath = this.getLocalFilePath(key);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (unlinkErr) {
        this.logger.warn(
          `Failed to remove local file ${filePath}: ${getErrorMessage(unlinkErr)}`,
        );
      }
    }
  }

  async getObjectStream(key: string) {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });
      return await this.s3Client.send(command);
    } catch (s3Err) {
      this.logger.debug(
        `R2 getObject failed for ${key}, checking local fallback: ${getErrorMessage(s3Err)}`,
      );
      const filePath = this.getLocalFilePath(key);
      if (fs.existsSync(filePath)) {
        const stream = fs.createReadStream(filePath);
        const stat = fs.statSync(filePath);
        return {
          Body: stream as any,
          ContentLength: stat.size,
          ContentType: 'application/octet-stream',
        };
      }
      throw s3Err;
    }
  }
}
