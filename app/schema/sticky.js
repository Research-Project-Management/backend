import mongoose from "mongoose";

const stickySchema = new mongoose.Schema({
  title: { type: String, default: "" },
  content: { type: String, required: true },
  color: { 
    type: String, 
    enum: ['cyan-1', 'cyan-2', 'mint-1', 'mint-2', 'yellow-1', 'lavender-1', 'pink-1', 'purple-1'],
    default: 'yellow-1'
  },
  workspace: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Workspace",
    required: true
  },
  tags: [{ type: mongoose.Schema.Types.ObjectId, ref: "Tag" }],
  author: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  position: {
    x: { type: Number, default: 0 },
    y: { type: Number, default: 0 }
  }
}, { timestamps: true });

stickySchema.index({ workspace: 1, createdAt: -1 });
stickySchema.index({ workspace: 1, tags: 1 });
stickySchema.index({ content: 'text', title: 'text' });

const StickyModel = mongoose.models.Sticky || mongoose.model("Sticky", stickySchema);
export default StickyModel;