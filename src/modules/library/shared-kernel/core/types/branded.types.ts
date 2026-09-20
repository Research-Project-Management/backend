/**
 * Canonical Branded ID & Nominal Types for Flux Library.
 * Implements Matt Pocock's Total TypeScript Nominal Branding Pattern.
 * Prevents accidental cross-assignment of UUIDs across distinct entity domains.
 */

declare const _brand: unique symbol;

/**
 * Nominal Branding Utility.
 * Attaches a compile-time unique brand tag to a base type with zero runtime cost.
 */
export type Brand<T, TBrand extends string> = T & { readonly [_brand]: TBrand };

// ─── Entity ID Brands ────────────────────────────────────────────────────────

export type ItemId = Brand<string, 'ItemId'>;
export type AttachmentId = Brand<string, 'AttachmentId'>;
export type AnnotationId = Brand<string, 'AnnotationId'>;
export type CollectionId = Brand<string, 'CollectionId'>;
export type TagId = Brand<string, 'TagId'>;
export type NoteId = Brand<string, 'NoteId'>;
export type SavedSearchId = Brand<string, 'SavedSearchId'>;
export type UserId = Brand<string, 'UserId'>;
export type ProjectId = Brand<string, 'ProjectId'>;

// ─── Trust Boundary Casting Helpers ──────────────────────────────────────────

export function asItemId(id: string): ItemId {
  return id as ItemId;
}

export function asAttachmentId(id: string): AttachmentId {
  return id as AttachmentId;
}

export function asAnnotationId(id: string): AnnotationId {
  return id as AnnotationId;
}

export function asCollectionId(id: string): CollectionId {
  return id as CollectionId;
}

export function asTagId(id: string): TagId {
  return id as TagId;
}

export function asNoteId(id: string): NoteId {
  return id as NoteId;
}

export function asSavedSearchId(id: string): SavedSearchId {
  return id as SavedSearchId;
}

export function asUserId(id: string): UserId {
  return id as UserId;
}

export function asProjectId(id: string): ProjectId {
  return id as ProjectId;
}

// ─── Type Guards ─────────────────────────────────────────────────────────────

export function isNonEmptyString(val: unknown): val is string {
  return typeof val === 'string' && val.trim().length > 0;
}

export function isItemId(val: unknown): val is ItemId {
  return isNonEmptyString(val);
}

export function isAttachmentId(val: unknown): val is AttachmentId {
  return isNonEmptyString(val);
}

export function isAnnotationId(val: unknown): val is AnnotationId {
  return isNonEmptyString(val);
}
