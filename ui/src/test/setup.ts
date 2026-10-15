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
