/**
 * Branded ID types — Matt Pocock pattern.
 * Prevents accidental mixing of ID strings across entity types.
 *
 * Usage:
 *   const annotationId = annotation.id as AnnotationId;
 *   function getById(id: AnnotationId) { ... }
 */

declare const _brand: unique symbol;

/** Utility for creating nominal/branded types */
export type Brand<T, TBrand extends string> = T & { readonly [_brand]: TBrand };

// ─── Entity ID Brands ────────────────────────────────────────────────────────

export type AnnotationId = Brand<string, 'AnnotationId'>;
export type AttachmentId = Brand<string, 'AttachmentId'>;
export type UserId = Brand<string, 'UserId'>;
export type ItemId = Brand<string, 'ItemId'>;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Cast a raw string to a branded ID (use only at trust boundaries) */
export function asAnnotationId(id: string): AnnotationId {
  return id as AnnotationId;
}

export function asAttachmentId(id: string): AttachmentId {
  return id as AttachmentId;
}

export function asUserId(id: string): UserId {
  return id as UserId;
}
