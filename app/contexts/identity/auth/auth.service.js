import bcrypt from "bcrypt";
import { AppError } from "../../../lib/AppError.js";

export class AuthService {
  constructor({ authRepository }) {
    this.authRepository = authRepository;
  }

  async registerUser({ name, email, password }) {
    const existing = await this.authRepository.findByEmail(email);
    if (existing) throw new AppError("Email is already in use", 400, "EMAIL_ALREADY_IN_USE");
    const hashedPassword = await bcrypt.hash(password, 12);
    const user = await this.authRepository.create({ name, email, password: hashedPassword });
    return { _id: user._id, name: user.name, email: user.email, avatar: user.avatar ?? null };
  }

  async searchUsers(query, currentUserId) {
    if (!query || query.length < 2) return [];
    return this.authRepository.searchByNameOrEmail(query, currentUserId);
  }

  async updateProfile(userId, { name, avatar }) {
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (avatar !== undefined) updates.avatar = avatar;
    if (Object.keys(updates).length === 0) throw new AppError("No fields to update", 400);
    const user = await this.authRepository.updateById(userId, updates);
    if (!user) throw new AppError("User not found", 404);
    return user;
  }

  async changePassword(userId, { currentPassword, newPassword }) {
    const user = await this.authRepository.findById(userId);
    if (!user) throw new AppError("User not found", 404);
    if (!user.password) throw new AppError("Password changes are only available for accounts registered with email and password.", 403);
    const isValid = await user.comparePassword(currentPassword);
    if (!isValid) throw new AppError("Current password is incorrect", 400);
    user.password = await bcrypt.hash(newPassword, 12);
    await user.save();
  }
}




