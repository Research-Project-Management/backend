import { ConfigService } from '@nestjs/config';
import { IStorageDriver } from '../../domain/ports/storage-driver.port';
import { S3StorageDriver } from './s3.driver';
import { LocalStorageDriver } from './local.driver';

export function createStorageDriver(config: ConfigService): IStorageDriver {
  const driverType = (
    config.get<string>('STORAGE_DRIVER') ||
    process.env.STORAGE_DRIVER ||
    's3'
  ).toLowerCase();

  if (driverType === 'local') {
    const localPath = config.get<string>('LOCAL_STORAGE_PATH') || './storage';
    return new LocalStorageDriver(localPath);
  }

  // AWS S3 / Cloudflare R2 / MinIO configuration
  const apiUrl =
    config.get<string>('R2_API_URL') || process.env.R2_API_URL || '';
  const accountId =
    config.get<string>('R2_ACCOUNT_ID') || process.env.R2_ACCOUNT_ID || '';
  const accessKeyId =
    config.get<string>('R2_ACCESS_KEY') ||
    process.env.R2_ACCESS_KEY ||
    config.get<string>('R2_ACCESS_KEY_ID') ||
    process.env.R2_ACCESS_KEY_ID ||
    config.get<string>('AWS_ACCESS_KEY_ID') ||
    process.env.AWS_ACCESS_KEY_ID ||
    '';
  const secretAccessKey =
    config.get<string>('R2_SECRET_KEY') ||
    process.env.R2_SECRET_KEY ||
    config.get<string>('R2_SECRET_ACCESS_KEY') ||
    process.env.R2_SECRET_ACCESS_KEY ||
    config.get<string>('AWS_SECRET_ACCESS_KEY') ||
    process.env.AWS_SECRET_ACCESS_KEY ||
    '';
  const bucket =
    config.get<string>('R2_BUCKET_NAME') ||
    process.env.R2_BUCKET_NAME ||
    config.get<string>('S3_BUCKET') ||
    process.env.S3_BUCKET ||
    'flux';

  const endpoint = apiUrl
    ? apiUrl
    : accountId
      ? `https://${accountId}.r2.cloudflarestorage.com`
      : config.get<string>('S3_ENDPOINT') || undefined;

  const region = config.get<string>('S3_REGION') || 'auto';
  const forcePathStyle = config.get<boolean>('S3_FORCE_PATH_STYLE') ?? false;

  return new S3StorageDriver({
    endpoint,
    region,
    bucket,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle,
  });
}
