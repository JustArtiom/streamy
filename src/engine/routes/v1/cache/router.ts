import { Router } from "express";
import * as cacheClearPost from "./cache-clear.post";
import * as cacheGet from "./cache.get";

// The video folder: usage, and "Clear now" (main's Settings → Storage).
export const cacheRouter = Router();

cacheRouter.get("/cache", cacheGet.handler);
cacheRouter.post("/cache/clear", cacheClearPost.handler);
