import { ConfigService } from '@nestjs/config';
import { IStorageAdapter } from '../types/adapter.type';
import { S3StorageAdapter } from './s3.adapter';
import { LocalStorageAdapter } from './local.adapter';

export function createStorageAdapter(config: ConfigService): IStorageAdapter {
  const driverType = (
    config.get<string>('STORAGE_DRIVER') ||
    process.env.STORAGE_DRIVER ||
    's3'
  ).toLowerCase();

  if (driverType === 'local') {
    const localPath = config.get<string>('LOCAL_STORAGE_PATH') || './storage';
    return new LocalStorageAdapter(localPath);
  }

  const getFirst = (...keys: string[]): string => {
    for (const key of keys) {
      const val = config.get<string>(key) || process.env[key];
      if (val) return val;
    }
    return '';
  };

  const apiUrl = getFirst('R2_API_URL');
  const accountId = getFirst('R2_ACCOUNT_ID');
  const accessKeyId = getFirst(
    'R2_ACCESS_KEY',
    'R2_ACCESS_KEY_ID',
    'AWS_ACCESS_KEY_ID',
  );
  const secretAccessKey = getFirst(
    'R2_SECRET_KEY',
    'R2_SECRET_ACCESS_KEY',
    'AWS_SECRET_ACCESS_KEY',
  );
  const bucket = getFirst('R2_BUCKET_NAME', 'S3_BUCKET') || 'flux';

  const endpoint = apiUrl
    ? apiUrl
    : accountId
      ? `https://${accountId}.r2.cloudflarestorage.com`
      : config.get<string>('S3_ENDPOINT') || undefined;

  const region = config.get<string>('S3_REGION') || 'auto';
  const forcePathStyle = config.get<boolean>('S3_FORCE_PATH_STYLE') ?? false;

  return new S3StorageAdapter({
    endpoint,
    region,
    bucket,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle,
  });
}
