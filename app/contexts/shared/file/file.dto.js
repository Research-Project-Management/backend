import { z } from 'zod';

export const PresignDto = {
  body: z
    .object({
      filename: z.string().trim().min(1).optional(),
      fileName: z.string().trim().min(1).optional(),
      contentType: z.string().trim().min(1).optional(),
    })
    .strict()
    .refine((data) => data.filename || data.fileName, {
      message: 'Either filename or fileName is required',
      path: ['filename'],
    }),
};

export const UploadFileDto = {
  body: z.object({
    filename: z.string().trim().min(1, 'Filename is required'),
    size: z.number().optional(),
    mimeType: z.string().optional(),
    url: z.string().trim().min(1).optional(),
    thumbnail: z.string().optional().nullable(),
    workspaceId: z.string().optional().nullable(),
    projectId: z.string().optional().nullable(),
    parentId: z.string().optional().nullable(),
    metaData: z.record(z.unknown()).optional(),
    pageId: z.string().optional().nullable(),
    fileBase64: z.string().optional().nullable(),
  }).strict(),
};

export const CreateFolderDto = {
  body: z.object({
    name: z.string().trim().min(1, 'Folder name is required'),
    workspaceId: z.string().optional().nullable(),
    projectId: z.string().optional().nullable(),
    parentId: z.string().optional().nullable(),
    pageId: z.string().optional().nullable(),
  }).strict(),
};

export const UpdateFileDto = {
  body: z.object({
    name: z.string().trim().min(1).optional(),
    parentId: z.string().optional().nullable(),
  }).strict(),
};
