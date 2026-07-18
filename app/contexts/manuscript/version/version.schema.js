import mongoose from "mongoose";

const versionSchema = new mongoose.Schema(
  {
    page: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Page",
      required: true,
      index: true,
    },
    projectPageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Page",
      index: true,
    },
    content: { type: String, default: "" },
    title: { type: String, default: "" },
    label: { type: String, default: "" },
    savedById: {
      type: String,
    },
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
    fileName: { type: String, default: "" },
  },
  { timestamps: true },
);

const VersionModel = mongoose.models.Version || mongoose.model("Version", versionSchema);
export default VersionModel;
