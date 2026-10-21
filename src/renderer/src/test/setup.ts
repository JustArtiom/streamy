import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { fakeStreamy } from "@/test/fake-streamy";

// The UI expects the preload script's API. Installed before any test file
// is imported, because some modules subscribe to it as soon as they load.
window.streamy = fakeStreamy.api;

/**
 * jsdom knows about <dialog> but hasn't implemented show(), showModal() or
 * close(). This is the smallest stand-in that behaves the way our Dialog
 * relies on: `open` flips, and closing fires a "close" event. It doesn't do
 * the top layer, focus trapping or Esc; only a real browser can check those.
 */
function openDialog(this: HTMLDialogElement) {
  this.open = true;
}

function closeDialog(this: HTMLDialogElement, returnValue?: string) {
  if (!this.open) return;
  this.open = false;
  if (returnValue !== undefined) this.returnValue = returnValue;
  this.dispatchEvent(new Event("close"));
}

HTMLDialogElement.prototype.show = openDialog;
HTMLDialogElement.prototype.showModal = openDialog;
HTMLDialogElement.prototype.close = closeDialog;

afterEach(() => {
  cleanup();
});
