import http from "http";
import express from "express";
import dotenv from "dotenv";
dotenv.config();
import connectDB from "./app/config/db.js";
import { connectRedis, redisClient } from "./app/config/redis.js";
import { initSocket } from "./app/libs/socket.js";
import authRouter from "./app/route/auth.js";
import workspaceRouter from "./app/route/workspace.js";
import projectRouter from "./app/route/project.js";
import pageRouter from "./app/route/page.js";
import taskRouter from "./app/route/task.js";
import cycleRouter from "./app/route/cycle.js";
import stickyRouter from "./app/route/sticky.js";
import roleRouter from "./app/route/role.js";
import session from "express-session";
import { RedisStore } from "connect-redis";
import passport from "passport";
import initPassportLocal from "./app/config/passport.js";
import flash from "express-flash";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { RedisStore as RedisRateLimitStore } from "rate-limit-redis";
import fileRouter from "./app/route/files.js";
import aiRouter from "./app/route/ai.js";
import chatHistoryRouter from "./app/route/chatHistory.js";
import latexRouter from "./app/route/latex.js";
import commentRouter from "./app/route/pageComment.js";
import taskCommentRouter from "./app/route/taskComment.js";
import libraryRouter from "./app/route/library.js";
//config

const PORT = process.env.PORT;
const app = express();
connectDB(process.env.MONGODB_URI);
await connectRedis();
app.set("trust proxy", 1);

//middleware
// Security headers
app.use(
  helmet({
    contentSecurityPolicy: false, // Disable CSP for OAuth
    crossOriginEmbedderPolicy: false,
  }),
);

// Rate limiting với Redis - chỉ áp dụng cho API, bỏ qua auth routes
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 phút
  max: process.env.NODE_ENV === "production" ? 100 : 1000, // Development: 1000, Production: 100
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisRateLimitStore({
    sendCommand: (...args) => redisClient.sendCommand(args),
  }),
  message: "Too many requests from this IP, please try again later.",
  // Bỏ qua rate limit cho auth routes để tránh lỗi 429 khi OAuth
  skip: (req) => req.path.startsWith("/auth/"),
});
app.use(limiter);

app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://localhost:2915",
      "http://localhost:2916",
      "http://localhost:3000",
      "https://flux.aisq.dev",
      ...(process.env.ORIGINS ? process.env.ORIGINS.split(",").map((o) => o.trim()) : []),
    ],
    credentials: true,
  }),
);

app.use(flash());

// Session với Redis store
const redisStore = new RedisStore({
  client: redisClient,
  prefix: "rpm:sess:",
  ttl: 7 * 24 * 60 * 60, // 7 ngày (giây)
});

app.use(
  session({
    store: redisStore,
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 7 * 24 * 60 * 60 * 1000,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    },

  }),
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
app.use("/api", cycleRouter);
app.use("/api", stickyRouter);
app.use("/api/files", fileRouter);
app.use("/api/ai", aiRouter);
app.use("/api/ai", chatHistoryRouter);
app.use("/api/roles", roleRouter);
app.use("/api/latex", latexRouter);
app.use("/api", commentRouter);
app.use("/api", taskCommentRouter);
app.use("/api/library", libraryRouter);
//listen
const server = http.createServer(app);
initSocket(server);
server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
