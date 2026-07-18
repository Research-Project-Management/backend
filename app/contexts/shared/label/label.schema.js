import mongoose from "mongoose";

const labelSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  color: { type: String, default: "#3b82f6" },
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId, ref: 'Workspace',
    required: true
  },
  createdById: {
    type: mongoose.Schema.Types.ObjectId, ref: 'User',
    required: true
  },
  type: { type: String, enum: ["sticky", "cycle", "task"], default: "sticky" }
}, { timestamps: true });

labelSchema.index({ workspaceId: 1, name: 1, type: 1 });

export const LabelModel =
  mongoose.models.Label || mongoose.model("Label", labelSchema, "labels");
