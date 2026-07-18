import { createClient } from "redis";
import dotenv from "dotenv";

// Đảm bảo env được load
dotenv.config();

const REDIS_URL = process.env.REDIS_URL;

const redisClient = createClient(
  REDIS_URL
    ? {
        url: REDIS_URL,
        socket: {
          tls: true, // Redis Cloud yêu cầu TLS
          rejectUnauthorized: false, // Cho phép self-signed certificates
        },
      }
    : {
        // Local development fallback
        socket: {
          host: process.env.REDIS_HOST || "localhost",
          port: process.env.REDIS_PORT || 6379,
        },
      },
);

redisClient.on("error", (err) => {
  console.error("Redis Client Error:", err);
});

redisClient.on("connect", () => {
  console.log("✅ Connected to Redis successfully");
});

redisClient.on("ready", () => {
  console.log("✅ Redis is ready to use");
});

// Kết nối Redis
const connectRedis = async () => {
  try {
    if (!redisClient.isOpen) {
      await redisClient.connect();
    }
  } catch (error) {
    console.error("Failed to connect to Redis:", error);
    process.exit(1);
  }
};

export { redisClient, connectRedis };
