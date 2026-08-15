import { z } from "zod";

export const IngestPaperDto = {
  body: z.object({
    source: z.enum(["upload", "storage", "identifier"]).optional().default("upload"),
    fileId: z.string().optional().nullable(),
    collectionId: z.string().optional().nullable(),
    title: z.string().optional(),
    filename: z.string().optional(),
    fileUrl: z.string().optional(),
    size: z.number().optional(),
    mimeType: z.string().optional(),
    authors: z.array(z.string()).optional().default([]),
    year: z.number().optional().nullable(),
    doi: z.string().optional(),
    citationKey: z.string().optional(),
  }),
};

export const UploadPaperDto = {
  body: z.object({
    collectionId: z.string().optional().nullable(),
    fileId: z.string().optional().nullable(),
    title: z.string().trim().min(1, "Title is required"),
    filename: z.string().min(1, "Filename is required"),
    fileUrl: z.string().min(1, "Valid file URL is required"),
    size: z.number().optional(),
    mimeType: z.string().optional(),
    authors: z.array(z.string()).optional().default([]),
    year: z.number().optional().nullable(),
    doi: z.string().optional(),
    citationKey: z.string().optional(),
    notes: z.array(
      z.object({
        _id: z.string().optional(),
        content: z.string().min(1),
        createdAt: z.any().optional(),
        updatedAt: z.any().optional(),
      })
    ).optional(),
  }),
};

export const AddAttachmentDto = {
  body: z.object({
    fileId: z.string().optional().nullable(),
    filename: z.string().min(1, "Filename is required"),
    url: z.string().min(1, "Valid attachment URL is required"),
    size: z.number().optional(),
    mimeType: z.string().optional(),
    attachmentType: z
      .enum(["primary_pdf", "supplementary", "dataset", "slides", "code", "figure", "other"])
      .optional()
      .default("supplementary"),
  }),
};

export const ImportStoragePaperDto = {
  body: z.object({
    fileId: z.string().min(1, "Storage fileId is required"),
    collectionId: z.string().optional().nullable(),
    title: z.string().optional(),
    authors: z.array(z.string()).optional(),
    doi: z.string().optional(),
    citationKey: z.string().optional(),
  }),
};

export const UpdatePaperDto = {
  body: z.object({
    title: z.string().trim().min(1).optional(),
    authors: z.array(z.string()).optional(),
    year: z.number().optional().nullable(),
    doi: z.string().optional(),
    abstract: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    itemType: z.string().optional(),
    editors: z.array(z.string()).optional(),
    journal: z.string().optional(),
    publicationTitle: z.string().optional(),
    publicationDate: z.string().optional(),
    publisher: z.string().optional(),
    place: z.string().optional(),
    labels: z.array(z.string()).optional(),
    volume: z.string().optional(),
    issue: z.string().optional(),
    section: z.string().optional(),
    partNumber: z.string().optional(),
    partTitle: z.string().optional(),
    pages: z.string().optional(),
    series: z.string().optional(),
    seriesTitle: z.string().optional(),
    seriesText: z.string().optional(),
    issn: z.string().optional(),
    isbn: z.string().optional(),
    pmid: z.string().optional(),
    pmcid: z.string().optional(),
    url: z.string().optional(),
    type: z.string().optional(),
    language: z.string().optional(),
    journalAbbr: z.string().optional(),
    shortTitle: z.string().optional(),
    rights: z.string().optional(),
    license: z.string().optional(),
    citationKey: z.string().optional(),
    libraryCatalog: z.string().optional(),
    archive: z.string().optional(),
    archiveLocation: z.string().optional(),
    callNumber: z.string().optional(),
    accessedAt: z.string().optional(),
    extra: z.string().optional(),
    notes: z.array(
      z.object({
        _id: z.string().optional(),
        content: z.string().min(1),
        createdAt: z.any().optional(),
        updatedAt: z.any().optional(),
      })
    ).optional(),
  }),
};
