// jsdom lacks modal dialogs; these follow the platform closely enough for
// the components' open, close and cancel handling.
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => { cleanup(); localStorage.clear(); });

const dialog = HTMLDialogElement.prototype;
dialog.showModal ??= function (this: HTMLDialogElement) { this.open = true; };
dialog.close = function (this: HTMLDialogElement, value?: string) {
  if (!this.open) return;
  if (value !== undefined) this.returnValue = value;
  this.open = false;
  this.dispatchEvent(new Event("close"));
};

// Canvas drawing and element resizing are not part of jsdom.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement["getContext"];
window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
