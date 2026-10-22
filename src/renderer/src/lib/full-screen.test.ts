import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeStreamy } from "@/test/fake-streamy";

// The store asks the main process once, when the module loads: each test
// loads a fresh copy.
async function freshStore() {
  vi.resetModules();
  return import("@/lib/full-screen");
}

beforeEach(() => {
  vi.resetModules();
});

describe("the window's full screen", () => {
  it("knows the window was already in full screen when the page loads (a reload)", async () => {
    fakeStreamy.api.window.isFullScreen.mockResolvedValueOnce(true);
    const { useWindowFullScreen } = await freshStore();

    const { result } = renderHook(() => useWindowFullScreen());

    await waitFor(() => {
      expect(result.current).toBe(true);
    });
  });

  it("follows changes, and a change wins over a late first answer", async () => {
    let answer: (fullScreen: boolean) => void = () => undefined;
    fakeStreamy.api.window.isFullScreen.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        answer = resolve;
      }),
    );
    const { useWindowFullScreen } = await freshStore();
    const { result } = renderHook(() => useWindowFullScreen());

    act(() => {
      fakeStreamy.setFullScreen(true);
    });
    expect(result.current).toBe(true);

    // Asked before the change, answered after it: out of date.
    await act(async () => {
      answer(false);
      await Promise.resolve();
    });
    expect(result.current).toBe(true);
  });

  it("does without a main process that can't answer", async () => {
    fakeStreamy.api.window.isFullScreen.mockRejectedValueOnce(
      new Error("No handler registered for 'window:get-full-screen'"),
    );
    fakeStreamy.api.window.setFullScreen.mockRejectedValueOnce(
      new Error("No handler registered for 'window:set-full-screen'"),
    );
    const { setWindowFullScreen, useWindowFullScreen } = await freshStore();
    const { result } = renderHook(() => useWindowFullScreen());

    // Neither throws nor leaves an unhandled rejection behind.
    setWindowFullScreen(false);
    await act(() => Promise.resolve());

    expect(result.current).toBe(false);
  });
});
