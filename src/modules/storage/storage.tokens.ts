/**
 * Dependency Injection Tokens for Storage Module
 * Adhering to Dependency Inversion Principle (DIP) in Clean Architecture
 */

export const STORAGE_DRIVER = Symbol('STORAGE_DRIVER');
export const STORAGE_NODE_REPOSITORY = Symbol('STORAGE_NODE_REPOSITORY');
export const STORAGE_BLOB_REPOSITORY = Symbol('STORAGE_BLOB_REPOSITORY');
export const UPLOAD_SESSION_REPOSITORY = Symbol('UPLOAD_SESSION_REPOSITORY');
export const STORAGE_QUOTA_REPOSITORY = Symbol('STORAGE_QUOTA_REPOSITORY');
export const STORAGE_VERSION_REPOSITORY = Symbol('STORAGE_VERSION_REPOSITORY');
export const STORAGE_REDIS_CACHE = Symbol('STORAGE_REDIS_CACHE');
export const STORAGE_FACADE = Symbol('STORAGE_FACADE');

// Legacy token for backward compatibility with Library and other modules
export const STORAGE_PORT = 'STORAGE_PORT';
