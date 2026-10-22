import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { electron, resetFakeElectron } from "../test/fake-electron";
import { QUIT_DRAIN, stopOnQuit } from "./index";
import type { IdleOptions } from "./proxy";

vi.mock(
  "electron",
  async () => (await import("../test/fake-electron")).electron,
);

const { app } = electron;

afterEach(() => {
  resetFakeElectron();
});

/** A host whose stop() finishes when the test says so. */
function fakeHost(hasProcess: boolean) {
  const stopped = Promise.withResolvers<undefined>();
  const host = {
    hasProcess,
    stop: vi.fn(() => stopped.promise),
  };
  return { host, finishStopping: stopped.resolve };
}

/** A proxy whose last requests drain when the test says so. */
function fakeProxy() {
  const idle = Promise.withResolvers<undefined>();
  const proxy = {
    close: vi.fn(),
    whenIdle: vi.fn((_options: IdleOptions) => idle.promise),
  };
  return { proxy, drain: idle.resolve };
}

/** Electron's last quitting step: every window has closed by now. */
function willQuit() {
  const event = { preventDefault: vi.fn() };
  app.emit("will-quit", event);
  return event;
}

describe("quitting stops the engine (stopOnQuit)", () => {
  it("lets the windows' last requests through, then stops the engine, then quits", async () => {
    const { host, finishStopping } = fakeHost(true);
    const { proxy, drain } = fakeProxy();
    stopOnQuit(host, proxy);

    expect(willQuit().preventDefault).toHaveBeenCalled();
    expect(proxy.whenIdle).toHaveBeenCalledWith(QUIT_DRAIN);
    // The engine keeps answering until the last save got there.
    await Promise.resolve();
    expect(host.stop).not.toHaveBeenCalled();

    drain(undefined);
    await vi.waitFor(() => {
      expect(host.stop).toHaveBeenCalledOnce();
    });
    // Asking again while it stops doesn't start a second stop.
    expect(willQuit().preventDefault).toHaveBeenCalled();
    expect(host.stop).toHaveBeenCalledOnce();
    expect(app.quit).not.toHaveBeenCalled();

    finishStopping(undefined);
    await vi.waitFor(() => {
      expect(app.quit).toHaveBeenCalledOnce();
    });
    expect(proxy.close).toHaveBeenCalledOnce();
    // The second round goes through.
    expect(willQuit().preventDefault).not.toHaveBeenCalled();
  });

  it("waits for the windows to close first: nothing happens on before-quit", () => {
    const { host } = fakeHost(true);
    const { proxy } = fakeProxy();
    stopOnQuit(host, proxy);

    const event = { preventDefault: vi.fn() };
    app.emit("before-quit", event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(host.stop).not.toHaveBeenCalled();
    expect(proxy.whenIdle).not.toHaveBeenCalled();
  });

  it("doesn't wait when the engine is already stopped (Restart to update)", () => {
    const { host } = fakeHost(false);
    const { proxy } = fakeProxy();
    stopOnQuit(host, proxy);

    expect(willQuit().preventDefault).not.toHaveBeenCalled();
    expect(proxy.whenIdle).not.toHaveBeenCalled();
    expect(proxy.close).toHaveBeenCalledOnce();
    expect(app.quit).not.toHaveBeenCalled();
  });

  it("stops the engine when Windows signs out or shuts down", () => {
    const { host } = fakeHost(true);
    const { proxy } = fakeProxy();
    stopOnQuit(host, proxy);
    const window = new EventEmitter();
    app.emit("browser-window-created", {}, window);

    window.emit("session-end", { reasons: ["logoff"] });

    expect(host.stop).toHaveBeenCalledOnce();
  });
});
