import mongoose from "mongoose";

const pageVersionSchema = new mongoose.Schema(
  {
    page: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Page",
      required: true,
      index: true,
    },
    /** Root page-project — allows querying all events for a project's timeline. */
    projectPageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Page",
      index: true,
    },
    // content is empty string for lifecycle events (file_created etc.)
    content: { type: String, default: "" },
    title: { type: String, default: "" },
    label: { type: String, default: "" },
    savedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    /**
     * manual_save  — user clicked "Save snapshot" in HistoryTab.
     * auto_save    — automatically recorded on content change (2-min sliding window).
     * file_created / file_deleted — a .tex child file was added/removed.
     * asset_uploaded / asset_deleted — a binary asset was added/removed.
     */
    eventType: {
      type: String,
      enum: [
        "manual_save",
        "auto_save",
        "file_created",
        "file_deleted",
        "asset_uploaded",
        "asset_deleted",
      ],
      default: "manual_save",
    },
    /** Name of the affected file (for display in the project timeline). */
    fileName: { type: String, default: "" },
  },
  { timestamps: true },
);

const PageVersionModel =
  mongoose.models.PageVersion ||
  mongoose.model("PageVersion", pageVersionSchema);
export default PageVersionModel;
