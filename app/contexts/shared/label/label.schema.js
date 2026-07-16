import mongoose from "mongoose";

// ── Tag Schema ────────────────────────────────────────────────────────────────

const labelSchema = new mongoose.Schema({
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
  },
  type: { type: String, enum: ["sticky", "cycle", "task"], default: "sticky" }
}, { timestamps: true });

labelSchema.index({ workspace: 1, name: 1, type: 1 });

// Cleanup hook: When a tag is deleted, remove its ID from all stickies and cycles
labelSchema.pre('findOneAndDelete', async function(next) {
  const doc = await this.model.findOne(this.getQuery());
  if (doc) {
    await Promise.all([
      mongoose.model("Sticky").updateMany(
        { labels: doc._id },
        { $pull: { labels: doc._id } }
      ),
      mongoose.model("Cycle").updateMany(
        { labels: doc._id },
        { $pull: { labels: doc._id } }
      ),
      mongoose.model("Task").updateMany(
        { labels: doc._id },
        { $pull: { labels: doc._id } }
      )
    ]);
  }
  next();
});

export const LabelModel =
  mongoose.models.Label || mongoose.model("Label", labelSchema, "tags");

export const TagModel = LabelModel;
