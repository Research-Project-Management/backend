import express from "express";
import dotenv from "dotenv";
dotenv.config();
import connectDB from "./app/config/db.js";
import authRouter from "./app/route/auth.js";
import workspaceRouter from "./app/route/workspace.js";
import projectRouter from "./app/route/project.js";
import pageRouter from "./app/route/page.js";
import taskRouter from "./app/route/task.js";
import session from "express-session";
import passport from "passport";
import initPassportLocal from "./app/config/passport.js";
import flash from "express-flash";
import cors from "cors";
import fileRouter from "./app/route/files.js";
//config

const PORT = process.env.PORT;
const app = express();
connectDB(process.env.MONGODB_URI);
app.set("trust proxy", 1);
//middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  cors({
    origin: ["http://localhost:5173"],
    credentials: true,
    secure: false,
  })
);
app.use(flash());
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      https: false,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      secure: false,
      sameSite: "lax",
    },
  })
);
app.use(passport.initialize());
app.use(passport.session());

initPassportLocal(passport);
//route
app.get("/", (req, res) => {
  res.json({ message: "Hello bro" });
});
app.use("/auth", authRouter);
app.use("/api/workspace", workspaceRouter);
app.use("/api", projectRouter);
app.use("/api", pageRouter);
app.use("/api", taskRouter);
app.use("/api/files", fileRouter);
//listen
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
