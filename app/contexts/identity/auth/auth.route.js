// contexts/identity/auth/auth.route.js
import { Router } from "express";
import { validate } from "../../../middleware/validate.middleware.js";
import { RegisterUserDto, LoginUserDto, UpdateProfileDto, ChangePasswordDto, ForgotPasswordDto } from "./auth.dto.js";
import { isAuthenticated } from "../../../middleware/auth.middleware.js";

export const buildAuthRouter = (authController) => {
  const authRouter = Router();

  authRouter.get("/user", authController.getMe);
  authRouter.post("/login", validate(LoginUserDto), authController.login);
  authRouter.post("/register", validate(RegisterUserDto), authController.register);
  authRouter.post("/forgot-password", validate(ForgotPasswordDto), authController.forgotPassword);
  authRouter.get("/logout", authController.logout);
  authRouter.get("/search", isAuthenticated, authController.searchUsers);
  authRouter.put("/profile", isAuthenticated, validate(UpdateProfileDto), authController.updateProfile);
  authRouter.put("/change-password", isAuthenticated, validate(ChangePasswordDto), authController.changePassword);
  authRouter.get("/github", authController.githubAuth);
  authRouter.get("/github/callback", authController.githubCallback);
  authRouter.get("/google", authController.googleAuth);
  authRouter.get("/google/callback", authController.googleCallback);

  return authRouter;
}
