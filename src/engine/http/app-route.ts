import type { Request, RequestHandler, Response } from "express";
import type { z } from "zod";

/**
 * A route middleware. Instead of mutating `req`, it returns the data it adds
 * (e.g. `{ user }`), so TypeScript knows about it in the handler.
 * Throw an AppError to stop the request.
 */
export type Middleware<Adds extends object> = (
  req: Request,
  res: Response,
) => Adds | Promise<Adds>;

// Merges what each middleware adds, one by one: [A, B, C] → A & B & C.
// Going one by one keeps a single middleware's own "either/or" result intact
// (e.g. auth({ required: false }) gives { user: User } OR { user: undefined }).
type MiddlewareContext<M extends readonly Middleware<object>[]> =
  M extends readonly [Middleware<infer First>, ...infer Rest]
    ? Rest extends readonly Middleware<object>[]
      ? First & MiddlewareContext<Rest>
      : First
    : object;

type InputContext<S> = S extends z.ZodType ? z.infer<S> : object;

type RouteOptions<M, S> = { middlewares?: M; schema?: S };

type RouteHandler<Ctx> = (
  ctx: Ctx,
  req: Request,
  res: Response,
) => void | Promise<void>;

/**
 * Wraps a route handler with typed middlewares and Zod validation.
 *
 *   appRoute(handler)            nothing to check, just the handler
 *   appRoute(options, handler)   { middlewares, schema } first
 *
 * Order: middlewares run first (in order), then the schema validates
 * `{ body, query, params }`. The handler gets everything merged into `ctx`.
 */
export function appRoute(handler: RouteHandler<object>): RequestHandler;
export function appRoute<
  const M extends readonly Middleware<object>[] = [],
  S extends z.ZodType | undefined = undefined,
>(
  options: RouteOptions<M, S>,
  handler: RouteHandler<MiddlewareContext<M> & InputContext<S>>,
): RequestHandler;
export function appRoute(
  ...args:
    | [RouteHandler<object>]
    | [
        RouteOptions<readonly Middleware<object>[], z.ZodType>,
        RouteHandler<object>,
      ]
): RequestHandler {
  // One argument means it's only the handler. Counting (instead of checking
  // `typeof args[0] === "function"`) lets TypeScript know the handler is there.
  const [options, handler]: [
    RouteOptions<readonly Middleware<object>[], z.ZodType>,
    RouteHandler<object>,
  ] = args.length === 1 ? [{}, args[0]] : args;

  return async (req, res) => {
    let ctx: object = {};

    for (const middleware of options.middlewares ?? []) {
      ctx = { ...ctx, ...(await middleware(req, res)) };
    }

    if (options.schema) {
      const input = options.schema.parse({
        body: req.body as unknown,
        query: req.query,
        params: req.params,
      }) as object;
      ctx = { ...ctx, ...input };
    }

    await handler(ctx, req, res);
  };
}
