// ΓöÇΓöÇ Version control ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

// List versions for a page (metadata only)
pageRouter.get(
  "/pages/:pageId/versions",
  isAuthenticated,
  checkPageAccess(["manager", "member", "viewer"]),
  async (req, res) => {
    try {
      const versions = await PageVersionModel.find({
        page: req.params.pageId,
        eventType: "manual_save",
      })
        .select("_id title label fileName savedBy createdAt")
        .populate("savedBy", "name avatar")
        .sort({ createdAt: -1 })
        .limit(50);
      res.json({ versions });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// Save current page content as a new version
pageRouter.post(
  "/pages/:pageId/versions",
  isAuthenticated,
  checkPageAccess(["manager", "member"]),
  async (req, res) => {
    try {
      const page = await PageModel.findById(req.params.pageId).select(
        "content title parentPage",
      );
      if (!page) return res.status(404).json({ error: "Page not found" });

      const { label = "" } = req.body;
      const projectPageId = page.parentPage ?? page._id;
      const texName = page.parentPage
        ? page.title.endsWith(".tex")
          ? page.title
          : `${page.title}.tex`
        : "main.tex";
      const version = await PageVersionModel.create({
        page: req.params.pageId,
        projectPageId,
        content: page.content ?? "",
        title: page.title,
        label,
        savedBy: req.user._id,
        eventType: "manual_save",
        fileName: texName,
      });
      await version.populate("savedBy", "name avatar");
      res.status(201).json({ version });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// Restore a version
pageRouter.post(
  "/pages/:pageId/versions/:versionId/restore",
  isAuthenticated,
  checkPageAccess(["manager", "member"]),
  async (req, res) => {
    try {
      const version = await PageVersionModel.findOne({
        _id: req.params.versionId,
        page: req.params.pageId,
      });
      if (!version) return res.status(404).json({ error: "Version not found" });

      const page = await PageModel.findByIdAndUpdate(
        req.params.pageId,
        { content: version.content },
        { new: true },
      ).select("_id title content");
      res.json({ page });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// Delete a version
pageRouter.delete(
  "/pages/:pageId/versions/:versionId",
  isAuthenticated,
  checkPageAccess(["manager", "member"]),
  async (req, res) => {
    try {
      const version = await PageVersionModel.findOneAndDelete({
        _id: req.params.versionId,
        page: req.params.pageId,
      });
      if (!version) return res.status(404).json({ error: "Version not found" });
      res.status(204).end();
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// ΓöÇΓöÇ Project history endpoints ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

// GET /pages/:rootPageId/history ΓÇö project-level event timeline
pageRouter.get(
  "/pages/:pageId/history",
  isAuthenticated,
  checkPageAccess(["manager", "member", "viewer"]),
  async (req, res) => {
    try {
      const events = await PageVersionModel.find({
        projectPageId: req.params.pageId,
        eventType: {
          $in: [
            "manual_save",
            "file_created",
            "file_deleted",
            "asset_uploaded",
            "asset_deleted",
          ],
        },
      })
        .select("_id eventType title label fileName savedBy createdAt page")
        .populate("savedBy", "name avatar")
        .sort({ createdAt: -1 })
        .limit(200);
      res.json({ events });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// POST /pages/:rootPageId/history/:eventId/restore ΓÇö restore all project files to snapshot
pageRouter.post(
  "/pages/:pageId/history/:eventId/restore",
  isAuthenticated,
  checkPageAccess(["manager", "member"]),
  async (req, res) => {
    try {
      const targetEvent = await PageVersionModel.findOne({
        _id: req.params.eventId,
        projectPageId: req.params.pageId,
      });
      if (!targetEvent)
        return res.status(404).json({ error: "Event not found" });

      const T = targetEvent.createdAt;
      const folderId = req.params.pageId;

      // Fetch all files in the project (root page + child files).
      const [rootPage, childFiles] = await Promise.all([
        PageModel.findById(folderId).select("_id title content parentPage"),
        PageModel.find({ parentPage: folderId }).select(
          "_id title content parentPage",
        ),
      ]);
      if (!rootPage)
        return res.status(404).json({ error: "Project not found" });

      const restored = [];
      for (const p of [rootPage, ...childFiles]) {
        // Find the most recent content snapshot at or before T.
        const snapshot = await PageVersionModel.findOne({
          page: p._id,
          eventType: { $in: ["manual_save", "auto_save"] },
          createdAt: { $lte: T },
        }).sort({ createdAt: -1 });

        if (snapshot) {
          await PageModel.findByIdAndUpdate(p._id, {
            content: snapshot.content,
          });
          const texName = p.parentPage
            ? p.title.endsWith(".tex")
              ? p.title
              : `${p.title}.tex`
            : "main.tex";
          syncFileToCompiler(
            folderId,
            texName,
            textToBase64(snapshot.content ?? ""),
          );
          restored.push({
            pageId: p._id.toString(),
            title: p.title,
            content: snapshot.content ?? "",
          });
        }
      }

      res.json({ restored, restoredAt: T });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// ΓöÇΓöÇ Version control (per-file) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

export default pageRouter;
