import { BusboyConfig } from '@fastify/busboy';

declare module 'fastify' {
  interface FastifyRequest {
    isMultipart(): boolean;
    parts(options?: Omit<BusboyConfig, 'headers'>): AsyncIterableIterator<any>;
  }
}
