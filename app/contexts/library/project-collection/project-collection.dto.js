import { z } from "zod";

export const CreateProjectCollectionDto = {
  body: z.object({
    name: z.string().trim().min(1, "Collection name is required"),
    description: z.string().optional(),
  }),
};

export const ImportLibraryCollectionDto = {
  body: z.object({
    collectionId: z.string().min(1, "Library collection ID is required"),
  }),
};

export const AddPaperToProjectCollectionDto = {
  body: z.object({
    paperId: z.string().min(1, "Paper ID is required"),
    note: z.string().optional(),
  }),
};

