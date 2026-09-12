/**
 * Nominal / Branded Types in TypeScript (Matt Pocock Pattern).
 * Prevents Primitive Obsession by giving domain identifiers a distinct nominal identity
 * at compile time while remaining regular primitives at runtime with zero overhead.
 */
declare const __brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [__brand]: B };

export type WorkspaceId = Brand<string, 'WorkspaceId'>;
export type ItemId = Brand<string, 'ItemId'>;
export type CollectionId = Brand<string, 'CollectionId'>;
export type TagId = Brand<string, 'TagId'>;
export type AttachmentId = Brand<string, 'AttachmentId'>;
export type AnnotationId = Brand<string, 'AnnotationId'>;
export type NoteId = Brand<string, 'NoteId'>;
export type UserId = Brand<string, 'UserId'>;

/** Helper function to safely cast a validated primitive string to a Branded identifier */
export function asBrand<T extends Brand<any, any>>(value: string): T {
  return value as T;
}
