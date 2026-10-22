import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { ENGINE_SECRET_HEADER } from "../../shared/engine-protocol";
import { AppError, ErrorCode } from "./errors";

/*
 * The engine listens on 127.0.0.1 only, but any program on this computer
 * (and any web page, through DNS rebinding) could still send it requests.
 * Two checks keep them out; main's proxy passes both.
 */

/**
 * DNS rebinding: a web page on evil.example makes its name resolve to
 * 127.0.0.1 and calls us "same-origin". The browser still sends
 * `Host: evil.example:<port>`, so anything but our exact address is refused.
 */
export const requireLoopbackHost: RequestHandler = (req, _res, next) => {
  const expected = `127.0.0.1:${req.socket.localPort ?? ""}`;
  if (req.headers.host !== expected) {
    throw new AppError(ErrorCode.Forbidden, "This address isn't allowed");
  }
  next();
};

/** sha256, so the comparison takes the same time whatever the lengths. */
function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** True when `given` is the secret. Constant time, whatever the input. */
export function isSecret(given: string | undefined, secret: string): boolean {
  if (given === undefined) return false;
  return timingSafeEqual(digest(given), digest(secret));
}

/**
 * /v1/* only answers requests carrying the secret (main's proxy adds it).
 * It's made by main for each engine start and never leaves main + engine.
 */
export function requireSecret(secret: string): RequestHandler {
  return (req, _res, next) => {
    const given = req.headers[ENGINE_SECRET_HEADER];
    if (!isSecret(typeof given === "string" ? given : undefined, secret)) {
      throw new AppError(ErrorCode.Unauthorized, "Missing or wrong key");
    }
    next();
  };
}
