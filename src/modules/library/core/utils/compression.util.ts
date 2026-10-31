import { promisify } from 'util';
import * as zlib from 'zlib';

export const gzipAsync = promisify(zlib.gzip);
export const gunzipAsync = promisify(zlib.gunzip);
