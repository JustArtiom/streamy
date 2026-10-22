import { ErrorCode, type ValidationIssue } from "../../shared/engine-api";

export { ErrorCode };

type AppErrorOptions = {
  /** Per-field problems (for VALIDATION_FAILED). */
  issues?: ValidationIssue[];
};

/**
 * An error meant for the API's caller: its code picks the HTTP status and
 * its message is shown to people. Anything else thrown becomes a generic
 * 500 "Something went wrong" (the details only go to the log).
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly issues?: ValidationIssue[];

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.issues = options.issues;
  }
}
