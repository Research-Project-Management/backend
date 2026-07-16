import { z } from "zod";

export const CreateCollectionDto = {
  body: z.object({
    name: z.string().trim().min(1, "Collection name is required"),
    description: z.string().optional(),
    color: z.string().optional(),
    icon: z.string().optional(),
    parent: z.string().optional().nullable(),
  }),
};

export const UpdateCollectionDto = {
  body: z.object({
    name: z.string().trim().min(1, "Collection name is required").optional(),
    description: z.string().optional(),
    color: z.string().optional(),
    icon: z.string().optional(),
    parent: z.string().optional().nullable(),
  }),
};

