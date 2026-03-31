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
      return res.status(500).json({
        type: err.type || "NULL_TYPE",
        error: err.message || "Internal server error",
      });
    }
    if (!user) {
      return res.status(401).json({
        type: info?.type || "INVALID_CREDENTIALS",
        error: info?.message || "Invalid credentials",
      });
    }
    req.login(user, (err) => {
      if (err) {
        return res.status(500).json({
          type: err.type || "LOGIN_ERROR",
          error: err.message || "Login failed",
        });
      }
      return res.json({ user });
    });
  })(req, res, next);
});

authRouter.post("/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (name == null || email == null || password == null) {
      return res.status(400).json({
        type: "MISSING_REQUIRED_FIELDS",
        error: "Name, email and password are required",
      });
    }

    const normalizedName = String(name).trim();
    const normalizedEmail = String(email).trim().toLowerCase();
    const normalizedPassword = String(password);

    if (!normalizedName) {
      return res.status(400).json({
        type: "INVALID_NAME",
        error: "Name is required",
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(normalizedEmail)) {
      return res.status(400).json({
        type: "INVALID_EMAIL",
        error: "Email is invalid",
      });
    }

    if (normalizedPassword.length < 6) {
      return res.status(400).json({
        type: "INVALID_PASSWORD",
        error: "Password must be at least 6 characters",
      });
    }

    const existedUser = await UserModel.findOne({ email: normalizedEmail });

    if (existedUser) {
      return res.status(400).json({
        type: "EMAIL_ALREADY_IN_USE",
        error: "Email is already in use",
      });
    }

    const hashedPassword = await bcrypt.hash(normalizedPassword, 10);

    const user = new UserModel({
      name: normalizedName,
      email: normalizedEmail,
      password: hashedPassword,
    });

    await user.save();

    return res.status(201).json({
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        avatar: user.avatar ?? null,
      },
    });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(400).json({
        type: "EMAIL_ALREADY_IN_USE",
        error: "Email is already in use",
      });
    }

    console.error("[AUTH][REGISTER]", error);

    return res.status(500).json({
      type: "INTERNAL_SERVER_ERROR",
      error: "Internal server error",
    });
  }
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
