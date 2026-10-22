import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HIDDEN_RELEASE_MS,
  useKeepScreenAwake,
} from "@/components/player/use-keep-screen-awake";
import { fakeStreamy } from "@/test/fake-streamy";

const { setPlaying } = fakeStreamy.api.player;

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  // @ts-expect-error -- back to jsdom's own value.
  delete document.visibilityState;
});

describe("useKeepScreenAwake", () => {
  it("says true while playing and false when it stops", () => {
    const { rerender, unmount } = renderHook(
      ({ playing }) => {
        useKeepScreenAwake(playing);
      },
      { initialProps: { playing: false } },
    );
    expect(setPlaying).not.toHaveBeenCalled();

    rerender({ playing: true });
    expect(setPlaying).toHaveBeenLastCalledWith(true);
    rerender({ playing: false });
    expect(setPlaying).toHaveBeenLastCalledWith(false);

    rerender({ playing: true });
    unmount();
    expect(setPlaying).toHaveBeenLastCalledWith(false);
    expect(setPlaying).toHaveBeenCalledTimes(4);
  });

  it("lets the screen sleep once the window has been hidden a while", () => {
    renderHook(() => {
      useKeepScreenAwake(true);
    });
    expect(setPlaying).toHaveBeenLastCalledWith(true);

    // A quick look at another app changes nothing.
    act(() => {
      setVisibility("hidden");
      vi.advanceTimersByTime(HIDDEN_RELEASE_MS - 1000);
      setVisibility("visible");
    });
    expect(setPlaying).toHaveBeenCalledTimes(1);

    act(() => {
      setVisibility("hidden");
      vi.advanceTimersByTime(HIDDEN_RELEASE_MS);
    });
    expect(setPlaying).toHaveBeenLastCalledWith(false);

    act(() => {
      setVisibility("visible");
    });
    expect(setPlaying).toHaveBeenLastCalledWith(true);
  });

  it("doesn't mind when the main process can't be told", () => {
    setPlaying.mockRejectedValueOnce(new Error("gone"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {
      // Expected.
    });

    renderHook(() => {
      useKeepScreenAwake(true);
    });

    return vi.waitFor(() => {
      expect(error).toHaveBeenCalled();
    });
  });
});
