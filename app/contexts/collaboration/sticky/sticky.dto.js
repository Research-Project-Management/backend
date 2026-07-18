import { z } from "zod";

export const CreateStickyDto = {
  body: z.object({
    title: z.string().optional(),
    content: z.string().trim().min(1, "Sticky content is required"),
    color: z.enum(['cyan-1', 'cyan-2', 'mint-1', 'mint-2', 'yellow-1', 'lavender-1', 'pink-1', 'purple-1']).optional(),
    scope: z.enum(["workspace", "project"]).optional(),
    projectId: z.string().optional().nullable(),
    position: z.object({ x: z.number(), y: z.number() }).optional(),
    labels: z.array(z.string()).optional(),
    parentStickyId: z.string().optional(),
  }),
};

export const UpdateStickyDto = {
  body: z.object({
    title: z.string().optional(),
    content: z.string().trim().min(1).optional(),
    color: z.enum(['cyan-1', 'cyan-2', 'mint-1', 'mint-2', 'yellow-1', 'lavender-1', 'pink-1', 'purple-1']).optional(),
    position: z.object({ x: z.number(), y: z.number() }).optional(),
    labels: z.array(z.string()).optional(),
    projectId: z.string().optional().nullable(),
  }),
};

export const ReorderStickiesDto = {
  body: z.object({
    stickyIds: z.array(z.string()).min(1, "Sticky IDs are required"),
  }),
};

export const AddChildStickyDto = {
  body: z.object({
    childStickyId: z.string().min(1, "Child Sticky ID is required"),
  }),
};
