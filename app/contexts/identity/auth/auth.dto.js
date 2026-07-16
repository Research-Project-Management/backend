import { z } from "zod";

export const RegisterUserDto = {
  body: z.object({
    name: z.string().trim().min(1, "Name is required"),
    email: z.string().trim().toLowerCase().email("Email is invalid"),
    password: z.string().min(6, "Password must be at least 6 characters"),
  }),
};

export const LoginUserDto = {
  body: z.object({
    email: z.string().trim().toLowerCase().email("Email is invalid"),
    password: z.string().min(1, "Password is required"),
  }),
};

export const UpdateProfileDto = {
  body: z.object({
    name: z.string().trim().min(1, "Name is required").optional(),
  }),
};

export const ChangePasswordDto = {
  body: z.object({
    currentPassword: z.string().min(1, "Current password is required"),
    newPassword: z.string().min(6, "New password must be at least 6 characters"),
  }),
};
