import type { ErrorRequestHandler, RequestHandler } from "express";
import { z } from "zod";
import type { ApiError } from "../../shared/engine-api";
import { AppError, ErrorCode } from "./errors";

const statusByCode: Record<ErrorCode, number> = {
  [ErrorCode.BadRequest]: 400,
  [ErrorCode.ValidationFailed]: 400,
  [ErrorCode.Unauthorized]: 401,
  [ErrorCode.Forbidden]: 403,
  [ErrorCode.NotFound]: 404,
  [ErrorCode.Conflict]: 409,
  [ErrorCode.PayloadTooLarge]: 413,
  [ErrorCode.Internal]: 500,
  [ErrorCode.ServiceUnavailable]: 503,
};

function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;

  if (err instanceof z.ZodError) {
    return new AppError(ErrorCode.ValidationFailed, "Some fields are invalid", {
      issues: err.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  // Errors from Express's body parsers.
  if (err instanceof Error && "type" in err) {
    if (err.type === "entity.parse.failed") {
      return new AppError(ErrorCode.BadRequest, "Invalid JSON body");
    }
    if (err.type === "entity.too.large") {
      return new AppError(
        ErrorCode.PayloadTooLarge,
        "The request body is too large",
      );
    }
  }

  return new AppError(ErrorCode.Internal, "Something went wrong");
}

export const notFoundHandler: RequestHandler = (req) => {
  throw new AppError(
    ErrorCode.NotFound,
    `Route ${req.method} ${req.path} not found`,
  );
};

/**
 * Every error → `ApiError` JSON with the code's HTTP status. Unknown errors
 * are answered "Something went wrong"; their details go to the log only
 * (pino-http logs `res.err`), never to the caller.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  // Part of the answer (e.g. a video stream) is already out: a JSON error
  // can't follow it. Express's default handler then closes the connection.
  if (res.headersSent) {
    next(err);
    return;
  }

  const appError = toAppError(err);

  if (appError.code === ErrorCode.Internal) {
    res.err = err instanceof Error ? err : new Error(String(err));
  }

  const error: ApiError["error"] = {
    code: appError.code,
    message: appError.message,
    issues: appError.issues,
    requestId: typeof req.id === "string" ? req.id : undefined,
  };

  res.status(statusByCode[appError.code]).json({ error });
};
