import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AppError, ErrorCode } from "./errors";
import { appRoute, type Middleware } from "./app-route";
import { errorHandler } from "./error-handler";

// A tiny app with one route: errors go through the real error handler.
function appWith(
  method: "get" | "post",
  path: string,
  handler: express.RequestHandler,
) {
  const app = express();
  app.use(express.json());
  app[method](path, handler);
  app.use(errorHandler);
  return app;
}

const withUser: Middleware<{ user: { id: string } }> = () => ({
  user: { id: "user-1" },
});
const withTeam: Middleware<{ team: string }> = async () => {
  await Promise.resolve();
  return { team: "team-1" };
};
const rejectEveryone: Middleware<{ user: { id: string } }> = () => {
  throw new AppError(ErrorCode.Unauthorized, "You need to be logged in");
};

describe("appRoute", () => {
  it("runs a route given just a handler (no options)", async () => {
    const app = appWith(
      "get",
      "/",
      appRoute((_ctx, _req, res) => {
        res.json({ ok: true });
      }),
    );

    const res = await request(app).get("/");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("puts middleware data into ctx and merges several middlewares", async () => {
    const app = appWith(
      "get",
      "/",
      appRoute({ middlewares: [withUser, withTeam] }, (ctx, _req, res) => {
        res.json({ userId: ctx.user.id, team: ctx.team });
      }),
    );

    const res = await request(app).get("/");

    expect(res.body).toEqual({ userId: "user-1", team: "team-1" });
  });

  it("gives the handler validated body, query and params", async () => {
    const schema = z.object({
      params: z.object({ id: z.string() }),
      query: z.object({ limit: z.coerce.number() }),
      body: z.object({ name: z.string() }),
    });
    const app = appWith(
      "post",
      "/items/:id",
      appRoute({ schema }, (ctx, _req, res) => {
        res.json({
          id: ctx.params.id,
          limit: ctx.query.limit,
          name: ctx.body.name,
        });
      }),
    );

    const res = await request(app)
      .post("/items/42?limit=10")
      .send({ name: "Artiom" });

    // limit arrives as a real number: the schema parsed it
    expect(res.body).toEqual({ id: "42", limit: 10, name: "Artiom" });
  });

  it("answers 400 VALIDATION_FAILED with issues for an invalid body", async () => {
    const schema = z.object({ body: z.object({ email: z.email() }) });
    const app = appWith(
      "post",
      "/",
      appRoute({ schema }, (_ctx, _req, res) => {
        res.json({ reached: true });
      }),
    );

    const res = await request(app).post("/").send({ email: "not-an-email" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(ErrorCode.ValidationFailed);
    expect(res.body.error.issues).toEqual([
      { path: "body.email", message: expect.any(String) },
    ]);
  });

  it("runs middlewares BEFORE validation (logged-out users get 401, not 400)", async () => {
    const schema = z.object({ body: z.object({ email: z.email() }) });
    const app = appWith(
      "post",
      "/",
      appRoute({ middlewares: [rejectEveryone], schema }, (_ctx, _req, res) => {
        res.json({ reached: true });
      }),
    );

    const res = await request(app).post("/").send({ email: "not-an-email" });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe(ErrorCode.Unauthorized);
  });

  it("passes errors thrown in the handler to the error handler", async () => {
    const app = appWith(
      "get",
      "/",
      appRoute(async () => {
        await Promise.resolve();
        throw new AppError(ErrorCode.NotFound, "Torrent not found");
      }),
    );

    const res = await request(app).get("/");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({
      code: ErrorCode.NotFound,
      message: "Torrent not found",
    });
  });
});
