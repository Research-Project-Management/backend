export class ErrorStrategyRegistry {
  constructor() {
    this.strategies = [];
  }

  register(conditionFn, handlerFn) {
    this.strategies.push({ conditionFn, handlerFn });
  }

  handle(err, req, res, isDev) {
    for (const { conditionFn, handlerFn } of this.strategies) {
      if (conditionFn(err)) {
        return handlerFn(err, req, res, isDev);
      }
    }
    return this.defaultHandler(err, req, res, isDev);
  }

  defaultHandler(err, req, res, isDev) {
    const statusCode = err.statusCode || err.status || 500;
    if (err.isOperational) {
      return res.status(statusCode).json({
        success: false,
        error: err.message,
        ...(err.type && { type: err.type }),
        ...(isDev && { stack: err.stack }),
      });
    }
    console.error("[UNHANDLED ERROR]", err);
    return res.status(500).json({
      success: false,
      error: "Internal Server Error",
      ...(isDev && { detail: err.message, stack: err.stack }),
      ...(process.env.NODE_ENV === "test" && { stack: err.stack }),
    });
  }
}

const errorRegistry = new ErrorStrategyRegistry();

// Mongoose duplicate key
errorRegistry.register(
  (err) => err.code === 11000,
  (err, req, res, isDev) => {
    const field = Object.keys(err.keyValue || {})[0] || "field";
    return res.status(409).json({ success: false, error: `${field} already exists`, type: "DUPLICATE_KEY" });
  }
);

// Mongoose validation error
errorRegistry.register(
  (err) => err.name === "ValidationError",
  (err, req, res, isDev) => {
    const messages = Object.values(err.errors).map((e) => e.message);
    return res.status(400).json({ success: false, error: messages.join(", "), type: "VALIDATION_ERROR" });
  }
);

// Mongoose CastError (invalid ObjectId)
errorRegistry.register(
  (err) => err.name === "CastError",
  (err, req, res, isDev) => {
    return res.status(400).json({ success: false, error: `Invalid ${err.path}: ${err.value}`, type: "INVALID_ID" });
  }
);

export const errorHandler = (err, req, res, next) => {
  const isDev = process.env.NODE_ENV !== "production";
  return errorRegistry.handle(err, req, res, isDev);
};

export const notFound = (req, res, next) => {
  const err = new Error(`Not found: ${req.method} ${req.originalUrl}`);
  err.statusCode = 404;
  err.isOperational = true;
  next(err);
};
