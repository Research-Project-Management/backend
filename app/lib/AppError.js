export class AppError extends Error {
  constructor(message, statusCode, type = null) {
    super(message);
    this.statusCode = statusCode;
    this.status = statusCode;
    this.type = type;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

export const notFound = (msg = "Not found") => new AppError(msg, 404);
export const forbidden = (msg = "Insufficient permissions") => new AppError(msg, 403);
export const badRequest = (msg, type = null) => new AppError(msg, 400, type);
export const conflict = (msg) => new AppError(msg, 409);
