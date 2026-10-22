import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { TEST_SECRET } from "../test/runtime";
import { createApp } from "./app";
import { errorHandler, notFoundHandler } from "./error-handler";
import { AppError, ErrorCode } from "./errors";

// A tiny app whose only route throws `error`, handled by the given error handler.
function appThrowing(
  error: unknown,
  handler: express.ErrorRequestHandler = errorHandler,
) {
  const app = express();
  app.use(express.json({ limit: "1kb" }));
  app.all("/boom", () => {
    throw error;
  });
  app.use(notFoundHandler);
  app.use(handler);
  return app;
}

describe("errorHandler", () => {
  it("turns an AppError into its status code and message", async () => {
    const res = await request(
      appThrowing(new AppError(ErrorCode.NotFound, "Torrent not found")),
    ).get("/boom");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({
      code: ErrorCode.NotFound,
      message: "Torrent not found",
    });
  });

  it.each([
    [ErrorCode.BadRequest, 400],
    [ErrorCode.ValidationFailed, 400],
    [ErrorCode.Unauthorized, 401],
    [ErrorCode.Forbidden, 403],
    [ErrorCode.NotFound, 404],
    [ErrorCode.Conflict, 409],
    [ErrorCode.PayloadTooLarge, 413],
    [ErrorCode.Internal, 500],
    [ErrorCode.ServiceUnavailable, 503],
  ])("maps %s to HTTP %i", async (code, status) => {
    const res = await request(appThrowing(new AppError(code, "x"))).get(
      "/boom",
    );
    expect(res.status).toBe(status);
  });

  it("turns a ZodError into 400 VALIDATION_FAILED with issues", async () => {
    const zodError = z
      .object({ body: z.object({ email: z.email(), age: z.number() }) })
      .safeParse({ body: { email: "nope", age: "old" } }).error;

    const res = await request(appThrowing(zodError)).get("/boom");

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(ErrorCode.ValidationFailed);
    expect(res.body.error.issues.map((i: { path: string }) => i.path)).toEqual([
      "body.email",
      "body.age",
    ]);
  });

  it("answers 400 BAD_REQUEST for broken JSON", async () => {
    const res = await request(appThrowing(null))
      .post("/boom")
      .set("content-type", "application/json")
      .send("{broken");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: ErrorCode.BadRequest,
      message: "Invalid JSON body",
    });
  });

  it("answers 413 PAYLOAD_TOO_LARGE for a body that is too large", async () => {
    const res = await request(appThrowing(null))
      .post("/boom")
      .send({ data: "x".repeat(2000) }); // limit in this test app is 1kb

    expect(res.status).toBe(413);
    expect(res.body.error).toMatchObject({
      code: ErrorCode.PayloadTooLarge,
      message: "The request body is too large",
    });
  });

  it("hides the real message of unknown errors (never leak internals)", async () => {
    const res = await request(
      appThrowing(new Error("db password is hunter2")),
    ).get("/boom");

    expect(res.status).toBe(500);
    expect(res.body.error).toMatchObject({
      code: ErrorCode.Internal,
      message: "Something went wrong",
    });
    expect(JSON.stringify(res.body)).not.toContain("hunter2");
  });

  it("answers 404 NOT_FOUND for unknown routes", async () => {
    const res = await request(appThrowing(null)).get("/does-not-exist");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({
      code: ErrorCode.NotFound,
      message: "Route GET /does-not-exist not found",
    });
  });

  it("never sends a stack", async () => {
    const res = await request(appThrowing(new Error("boom"))).get("/boom");
    expect(res.body.error.stack).toBeUndefined();
  });

  it("leaves it to Express when the response has already started", () => {
    const err = new Error("stream broke");
    const next = vi.fn();
    const status = vi.fn();
    const res = { headersSent: true, status } as unknown as express.Response;

    errorHandler(err, {} as express.Request, res, next);

    expect(next).toHaveBeenCalledWith(err);
    expect(status).not.toHaveBeenCalled();
  });

  it("closes the connection when a route fails mid-response", async () => {
    const app = express();
    app.get("/half", (_req, res) => {
      res.writeHead(200, { "content-length": "100" });
      res.write("only part of it");
      throw new Error("stream broke");
    });
    app.use(errorHandler);

    await expect(request(app).get("/half")).rejects.toThrow();
  });
});

describe("the real app", () => {
  it("returns the same requestId in the error body and the X-Request-Id header", async () => {
    const res = await request(createApp({ secret: TEST_SECRET })).get("/nope");

    expect(res.status).toBe(404);
    expect(res.body.error.requestId).toEqual(expect.any(String));
    expect(res.headers["x-request-id"]).toBe(res.body.error.requestId);
  });
});
