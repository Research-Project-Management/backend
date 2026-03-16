/**
 * Shared middleware helpers to reduce boilerplate in route files.
 */

/**
 * Maps `req.params.workspaceId` to `req.params.id` so that
 * `checkWorkspaceRole()` can find the workspace.
 *
 * Replaces the inline `(req, res, next) => { req.params.id = req.params.workspaceId; next(); }`
 * pattern that was duplicated across sticky, tag, and other routes.
 */
export const mapWorkspaceId = (req, res, next) => {
  req.params.id = req.params.workspaceId;
  next();
};

/**
 * Wraps an async route handler to automatically catch errors and send
 * a JSON error response. Eliminates the need for try/catch in every handler.
 *
 * Usage:
 *   router.get("/foo", asyncHandler(async (req, res) => {
 *     const data = await SomeModel.find();
 *     res.json({ data });
 *   }));
 */
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((error) => {
    console.error(`Route error: ${req.method} ${req.originalUrl}`, error);
    res.status(error.status || 500).json({ error: error.message });
  });
