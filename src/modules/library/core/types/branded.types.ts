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

// Entity ID Brands

export type ItemId = Brand<string, 'ItemId'>;
export type AttachmentId = Brand<string, 'AttachmentId'>;
export type AnnotationId = Brand<string, 'AnnotationId'>;
export type CollectionId = Brand<string, 'CollectionId'>;
export type TagId = Brand<string, 'TagId'>;
export type NoteId = Brand<string, 'NoteId'>;
export type SavedSearchId = Brand<string, 'SavedSearchId'>;
export type UserId = Brand<string, 'UserId'>;
export type ProjectId = Brand<string, 'ProjectId'>;
