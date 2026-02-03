import mongoose from "mongoose";

const tagSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  color: { type: String, default: "#3b82f6" },
  workspace: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: "Workspace", 
    required: true 
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  }
}, { timestamps: true });

tagSchema.index({ workspace: 1, name: 1 });

const TagModel = mongoose.models.Tag || mongoose.model("Tag", tagSchema);
export default TagModel;