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
    console.log("Authentication attempt:", { err, user, info });
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
    // console.log("Github authentication successful");
    res.redirect(process.env.CLIENT_URL || "http://localhost:5173/callback");
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
    // console.log("Google authentication successful");
    res.redirect(process.env.CLIENT_URL || "http://localhost:5173/callback");
  },
);

export default authRouter;
