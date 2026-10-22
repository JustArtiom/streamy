import { AppError, ErrorCode } from "../../../http/errors";
import { LibraryError, type LibraryStore } from "../../../library";
import { engineServices } from "../../../services";

// What the library routes share: getting the library, and turning its
// errors into the API's.

const UNAVAILABLE = "The library isn't available right now";

/** The engine's library, or 503 outside a running engine. */
export function requireLibrary(): LibraryStore {
  const library = engineServices()?.library;
  if (!library) throw new AppError(ErrorCode.ServiceUnavailable, UNAVAILABLE);
  return library;
}

/** A LibraryError as the API answers it; anything else unchanged. */
export function toApiError(err: unknown): unknown {
  if (!(err instanceof LibraryError)) return err;
  switch (err.code) {
    case "not_found":
      return new AppError(
        ErrorCode.NotFound,
        "This torrent isn't in the library",
      );
    case "invalid_input":
      return new AppError(
        ErrorCode.ValidationFailed,
        "Some fields are invalid",
        {
          issues: [{ path: err.field ?? "", message: err.message }],
        },
      );
    case "closed":
    case "newer_version":
    case "unavailable":
      return new AppError(ErrorCode.ServiceUnavailable, UNAVAILABLE);
  }
}

/** Runs a library call, with its errors turned into the API's. */
export function libraryCall<T>(work: () => T): T {
  try {
    return work();
  } catch (err) {
    throw toApiError(err);
  }
}
