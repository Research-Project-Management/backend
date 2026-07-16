import { z } from "zod";

export const CreateLabelDto = {
  body: z.object({
    name: z.string().trim().min(1, "Label name is required"),
    color: z.string().optional(),
    type: z.enum(["sticky", "cycle", "task"]).optional(),
  }),
};

export const UpdateLabelDto = {
  body: z.object({
    name: z.string().trim().min(1).optional(),
    color: z.string().optional(),
  }),
};
