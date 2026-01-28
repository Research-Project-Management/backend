import mongoose from "mongoose";

const pageSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    content: {
      type: mongoose.Schema.Types.Mixed, // Store JSON content from editor
      default: null,
    },
    status: {
      type: String,
      enum: ["draft", "approved", "archived"], // Matching frontend enum in PageItem.tsx
      default: "draft",
    },
    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
      required: true,
    },
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    views: {
      type: Number,
      default: 0,
    },
    lastAccessedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

const PageModel = mongoose.models.Page || mongoose.model("Page", pageSchema);
export default PageModel;
