import "@testing-library/jest-dom/vitest";
import { act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import { resetAnnouncerForTests } from "@/lib/announcer";
import { resetIpNoticeForTests } from "@/lib/ip-notice";
import { toast } from "@/lib/toast";
import { takeUnansweredEngineCalls } from "@/test/engine";
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

// Nor pointer capture, which toasts use for swiping (a press on a toast's
// button starts one).
Element.prototype.setPointerCapture = () => undefined;
Element.prototype.releasePointerCapture = () => undefined;
Element.prototype.hasPointerCapture = () => false;

// Every test starts with a running engine and nothing remembered.
beforeEach(() => {
  act(() => {
    fakeStreamy.reset();
  });
});

afterEach(() => {
  cleanup();
  // Sonner shows a new Toaster the toasts still open: without this, a
  // test's toasts would turn up in the next test.
  toast.dismiss();
  localStorage.clear();
  resetIpNoticeForTests();
  resetAnnouncerForTests();
  // A request the test didn't plan for is a bug in the page or the test.
  const unanswered = takeUnansweredEngineCalls();
  if (unanswered.length > 0) {
    throw new Error(
      `The page asked the fake engine for routes the test gave no answer:\n  ${[...new Set(unanswered)].join("\n  ")}\nAdd them to mockEngine({ … }).`,
    );
  }
});
