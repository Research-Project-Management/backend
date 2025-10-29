import mongoose from "mongoose";
import bcrypt from "bcrypt";
const UserSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      unique: true,
      sparse: true,
    },
    password: {
      type: String,
      default: null,
    },
    name: {
      type: String,
      default: "User",
    },
    avatar: {
      type: String,
      default: null,
    },
    isVerified: {
      type: Boolean,
      default: false,
    },
    googleId: {
      type: String,
      default: null,
    },
    githubId: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

UserSchema.methods.comparePassword = async function (pw) {
  return await bcrypt.compare(pw, this.password);
};

const UserModel = mongoose.models.User || mongoose.model("User", UserSchema);

export default UserModel;
