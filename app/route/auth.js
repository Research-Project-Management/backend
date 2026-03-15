import { Router } from "express";
import bcrypt from "bcrypt";
import passport from "passport";
import UserModel from "../schema/user.js";

const authRouter = Router();

authRouter.get("/user", (req, res) => {
  // console.log(req.headers.cookie);
  if (req.isAuthenticated()) {
    res.json({ user: req.user });
  } else {
    res.status(401).json({ error: "null" });
  }
});

authRouter.post("/login", (req, res, next) => {
  passport.authenticate("local", (err, user, info) => {
    if (err) {
      res.status(500).json({
        type: err.type || "NULL_TYPE",
        error: err.message || "Internal server error",
      });
    }
    if (user) {
      res.json({ user });
    }
  })(req, res, next);
});

authRouter.post("/register", async (req, res) => {
  const { password, name, email } = req.body;
  if (!password || !name || !email) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }
  const existedUser = await UserModel.findOne(email);
  if (existedUser)
    return res.status(400).json({
      type: "EMAIL_HAD_ALREADY_TO_USE",
      error: "Please use orther email",
    });
  const hashedPassword = await bcrypt.hash(password, 10);
  const user = new UserModel({ email, password: hashedPassword, name });
  await user.save();
  res.json(user);
});

authRouter.get(
  "/github",
  passport.authenticate("github", { scope: ["user:email"] }),
);

authRouter.get(
  "/github/callback",
  passport.authenticate("github", { failureRedirect: "/login" }),
  function (req, res) {
    // Login thành công, set session
    req.login(req.user, (err) => {
      if (err) {
        console.error("Error logging in:", err);
        return res.redirect("http://localhost:5173/login");
      }
      // Redirect về callback để đóng popup
      res.redirect(process.env.CLIENT_URL || "http://localhost:5173/callback");
    });
  },
);

authRouter.get(
  "/google",
  passport.authenticate("google", { scope: ["profile", "email"] }),
);

authRouter.get(
  "/google/callback",
  passport.authenticate("google", { failureRedirect: "/login" }),
  function (req, res) {
    // Login thành công, set session
    req.login(req.user, (err) => {
      if (err) {
        console.error("Error logging in:", err);
        return res.redirect("http://localhost:5173/login");
      }
      // Redirect về callback để đóng popup
      res.redirect(process.env.CLIENT_URL || "http://localhost:5173/callback");
    });
  },
);

// temp
authRouter.get("/logout", (req, res) => {
  req.logout(() => {
    req.session.destroy(() => {
      res.clearCookie("connect.sid");
      return res.status(200).json({ message: "Logged out successfully" });
    });
  });
});

// Search users
authRouter.get("/search", async (req, res) => {
  if (!req.isAuthenticated())
    return res.status(401).json({ error: "Unauthorized" });

  const { query } = req.query;
  if (!query || query.length < 2) return res.json({ users: [] });

  try {
    const users = await UserModel.find({
      $or: [
        { email: { $regex: query, $options: "i" } },
        { name: { $regex: query, $options: "i" } },
      ],
      _id: { $ne: req.user._id }, // Exclude self
    })
      .select("name email avatar")
      .limit(10);

    res.json({ users });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update user profile
authRouter.put("/profile", async (req, res) => {
  if (!req.isAuthenticated())
    return res.status(401).json({ error: "Unauthorized" });

  try {
    const { name, avatar } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = name.trim();
    if (avatar !== undefined) updates.avatar = avatar;

    if (Object.keys(updates).length === 0)
      return res.status(400).json({ error: "No fields to update" });

    const user = await UserModel.findByIdAndUpdate(req.user._id, updates, {
      new: true,
    }).select("-password");

    if (!user) return res.status(404).json({ error: "User not found" });

    // Update session
    req.user.name = user.name;
    req.user.avatar = user.avatar;

    res.json({ user });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Change password
authRouter.put("/change-password", async (req, res) => {
  if (!req.isAuthenticated())
    return res.status(401).json({ error: "Unauthorized" });

  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 6)
      return res
        .status(400)
        .json({ error: "Password must be at least 6 characters" });

    const user = await UserModel.findById(req.user._id);
    if (!user) return res.status(404).json({ error: "User not found" });

    // If user has a password (local auth), verify current password
    if (user.password) {
      if (!currentPassword)
        return res.status(400).json({ error: "Current password is required" });
      const isValid = await user.comparePassword(currentPassword);
      if (!isValid)
        return res.status(400).json({ error: "Current password is incorrect" });
    }

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    res.json({ message: "Password updated successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default authRouter;
