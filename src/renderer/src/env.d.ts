import type { StreamyApi } from "../../shared/api";

declare global {
  interface Window {
    /** Exposed by the preload script (src/preload/index.ts). */
    streamy: StreamyApi;
  }
}
