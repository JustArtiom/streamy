import { onlineManager } from "@tanstack/react-query";
import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApiRequestError, EngineUnavailableError } from "@/lib/api";
import {
  followEngineStatus,
  shouldRetry,
  shouldRetryMutation,
} from "@/lib/query-client";
import { fakeStreamy } from "@/test/fake-streamy";

describe("shouldRetry", () => {
  it("doesn't retry answers that won't change (4xx)", () => {
    expect(shouldRetry(0, new ApiRequestError(404, "NOT_FOUND", "x"))).toBe(
      false,
    );
    expect(shouldRetry(0, new ApiRequestError(400, "BAD_REQUEST", "x"))).toBe(
      false,
    );
  });

  it("retries network trouble and 5xx twice", () => {
    const error = new ApiRequestError(0, "NETWORK", "x");
    expect(shouldRetry(0, error)).toBe(true);
    expect(shouldRetry(1, error)).toBe(true);
    expect(shouldRetry(2, error)).toBe(false);
  });

  it("retries a stopped engine a few times (they wait for it)", () => {
    const error = new EngineUnavailableError();
    expect(shouldRetry(2, error)).toBe(true);
    expect(shouldRetry(3, error)).toBe(false);
  });
});

describe("shouldRetryMutation", () => {
  it("only retries when the engine wasn't there to receive it", () => {
    expect(shouldRetryMutation(0, new EngineUnavailableError())).toBe(true);
    expect(
      shouldRetryMutation(0, new ApiRequestError(500, "INTERNAL", "x")),
    ).toBe(false);
  });
});

describe("followEngineStatus", () => {
  it("is online exactly while the engine runs", () => {
    followEngineStatus();
    expect(onlineManager.isOnline()).toBe(true);

    act(() => {
      fakeStreamy.setEngineStatus({ state: "restarting", error: null });
    });
    expect(onlineManager.isOnline()).toBe(false);

    act(() => {
      fakeStreamy.setEngineStatus({ state: "failed", error: "Crashed" });
    });
    expect(onlineManager.isOnline()).toBe(false);

    act(() => {
      fakeStreamy.setEngineStatus({ state: "running", error: null });
    });
    expect(onlineManager.isOnline()).toBe(true);
  });
});
