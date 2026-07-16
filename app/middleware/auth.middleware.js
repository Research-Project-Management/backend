// app/middleware/auth.middleware.js
import UserModel from "../contexts/identity/auth/auth.schema.js";

export const isAuthenticated = async (req, res, next) => {
  const internalKey = req.headers["x-internal-key"];
  if (internalKey) {
    if (internalKey !== process.env.INTERNAL_API_KEY) {
      return res.status(401).json({ error: "Invalid internal API key" });
    }
    const userId = req.headers["x-user-id"];
    if (!userId) return res.status(400).json({ error: "Missing X-User-Id header" });
    try {
      const user = await UserModel.findById(userId);
      if (!user) return res.status(404).json({ error: "User not found" });
      req.user = user;
      req.isInternalRequest = true;
      return next();
    } catch (err) {
      return res.status(500).json({ error: "Internal auth failed" });
    }
  }
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: "Unauthorized" });
};
