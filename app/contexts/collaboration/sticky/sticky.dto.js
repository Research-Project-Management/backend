import { z } from "zod";

const StickyColor = z.enum([
  'cyan-1', 'cyan-2', 'mint-1', 'mint-2', 
  'yellow-1', 'lavender-1', 'pink-1', 'purple-1'
]);

const BaseStickySchema = z.object({
  title: z.string().optional(),
  content: z.string().trim().min(1, "Sticky content is required"),
  color: StickyColor.optional(),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
  projectId: z.string().optional().nullable(),
});

export const CreateStickyDto = {
  body: BaseStickySchema,
};

export const UpdateStickyDto = {
  body: BaseStickySchema.partial(),
};

export const ReorderStickiesDto = {
  body: z.object({
    stickyIds: z.array(z.string()).min(1, "Sticky IDs are required"),
  }),
};
