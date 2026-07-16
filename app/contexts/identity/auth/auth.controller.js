import passport from "passport";
import { asyncHandler } from "../../../lib/asyncHandler.js";

export class AuthController {
  constructor({ authService }) {
    this.authService = authService;
    this.passport = passport;

    this.getMe = (req, res) => {
      if (req.isAuthenticated()) return res.json({ user: req.user });
      res.status(401).json({ success: false, error: "Unauthorized" });
    };

    this.login = (req, res, next) => {
      this.passport.authenticate("local", (err, user, info) => {
        if (err) return next(err);
        if (!user) return res.status(401).json({ success: false, error: info?.message || "Invalid credentials", type: info?.type || "INVALID_CREDENTIALS" });
        req.login(user, (err) => { if (err) return next(err); return res.json({ user }); });
      })(req, res, next);
    };

    this.register = asyncHandler(async (req, res) => { res.status(201).json({ user: await this.authService.registerUser(req.body) }); });

    this.logout = (req, res) => {
      req.logout(() => { req.session.destroy(() => { res.clearCookie("connect.sid"); res.status(200).json({ message: "Logged out successfully" }); }); });
    };

    this.searchUsers = asyncHandler(async (req, res) => { res.json({ users: await this.authService.searchUsers(req.query.query, req.user._id) }); });

    this.updateProfile = asyncHandler(async (req, res) => {
      const user = await this.authService.updateProfile(req.user._id, req.body);
      req.user.name = user.name; req.user.avatar = user.avatar;
      res.json({ user });
    });

    this.changePassword = asyncHandler(async (req, res) => { await this.authService.changePassword(req.user._id, req.body); res.json({ message: "Password updated successfully" }); });

    this.githubAuth = this.passport.authenticate("github", { scope: ["user:email"] });
    this.githubCallback = [this.passport.authenticate("github", { failureRedirect: "/login" }), (req, res) => { req.login(req.user, (err) => { if (err) return res.redirect("http://localhost:2916/login"); res.redirect(process.env.CLIENT_URL || "http://localhost:2916/callback"); }); }];
    this.googleAuth = this.passport.authenticate("google", { scope: ["profile", "email"] });
    this.googleCallback = [this.passport.authenticate("google", { failureRedirect: "/login" }), (req, res) => { req.login(req.user, (err) => { if (err) return res.redirect("http://localhost:2916/login"); res.redirect(process.env.CLIENT_URL || "http://localhost:2916/callback"); }); }];
  }
}



