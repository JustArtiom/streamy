import { isInfoHash } from "../lib/info-hash";
import { LibraryError } from "./types";

// Checks on everything that goes into the library. Values come from HTTP
// requests and player heartbeats, so they're checked at run time even though
// TypeScript already knows their types (hence `unknown` parameters).

function invalid(field: string, message: string): LibraryError {
  return new LibraryError("invalid_input", `${field} ${message}`, { field });
}

export function checkInfoHash(value: unknown): string {
  if (!isInfoHash(value)) {
    throw invalid("infoHash", "must be 40 lowercase hex characters");
  }
  return value;
}

/** A whole number ≥ 0 (file indexes, audio tracks, sizes). */
export function checkIndex(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalid(field, "must be a whole number ≥ 0");
  }
  return value;
}

/** Rejects NaN, infinities and negative numbers. */
export function checkSeconds(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw invalid(field, "must be a finite number ≥ 0");
  }
  return value;
}

export function checkLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw invalid("limit", "must be a whole number ≥ 1");
  }
  return value;
}

/** A non-empty string (names, subtitle ids, magnet links). */
export function checkText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalid(field, "must be a non-empty string");
  }
  return value;
}

export function checkBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw invalid(field, "must be true or false");
  return value;
}

export function checkBytes(value: unknown, field: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw invalid(field, "must be non-empty bytes");
  }
  return value;
}

/** Runs `check` unless the value is null or undefined (kept as they are). */
export function optional<T>(
  value: unknown,
  check: (value: unknown) => T,
): T | null | undefined {
  if (value === null || value === undefined) return value;
  return check(value);
}
