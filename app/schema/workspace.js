import mongoose from "mongoose";

const workspaceMemberSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  role: {
    type: String,
    enum: ["owner", "admin", "member"],
    default: "member",
  },
  joinedAt: { type: Date, default: Date.now },
});

const workspaceSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    members: [workspaceMemberSchema],
    color: { type: String, default: "#1e2939" },
    avatar: { type: String, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    settings: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

export default mongoose.model("Workspace", workspaceSchema);
