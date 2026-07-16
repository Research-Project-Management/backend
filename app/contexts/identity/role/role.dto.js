import { z } from "zod";

const PermissionSchema = z.object({
  resource: z.string(),
  actions: z.array(z.string()),
});

export const CreateRoleDto = {
  body: z.object({
    name: z.string().trim().min(1, "Role name is required"),
    description: z.string().optional(),
    permissions: z.array(PermissionSchema).default([]),
    color: z.string().default("#6366f1"),
  }),
};

export const UpdateRoleDto = {
  body: z.object({
    name: z.string().trim().min(1, "Role name is required").optional(),
    description: z.string().optional(),
    permissions: z.array(PermissionSchema).optional(),
    color: z.string().optional(),
  }),
};
