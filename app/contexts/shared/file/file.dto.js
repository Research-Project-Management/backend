import { z } from "zod";

export const PresignDto = {
  body: z.object({
    filename: z.string().trim().min(1, "Filename is required"),
    contentType: z.string().trim().min(1, "Content type is required"),
  }),
};

export const UploadFileDto = {
  body: z.object({
    name: z.string().trim().min(1, "File name is required"),
    type: z.string().optional(),
    size: z.number().optional(),
    key: z.string().trim().min(1, "File key is required"),
    workspaceId: z.string().optional().nullable(),
    projectId: z.string().optional().nullable(),
    pageId: z.string().optional().nullable(),
    parentId: z.string().optional().nullable(),
  }),
};

export const CreateFolderDto = {
  body: z.object({
    name: z.string().trim().min(1, "Folder name is required"),
    workspaceId: z.string().optional().nullable(),
    projectId: z.string().optional().nullable(),
    pageId: z.string().optional().nullable(),
    parentId: z.string().optional().nullable(),
  }),
};

export const UpdateFileDto = {
  body: z.object({
    name: z.string().trim().min(1).optional(),
    parentId: z.string().optional().nullable(),
  }),
};
