/**
 * Simple module to hold a reference to the main Window instance.
 * This avoids circular dependencies between index.ts and tab-cdp-bridge.ts
 */

import type { Window } from './Window';

let mainWindowRef: Window | null = null;

/**
 * Set the main window reference (called from index.ts after window creation)
 */
export function setMainWindow(window: Window | null): void {
  mainWindowRef = window;
}

/**
 * Get the main window reference
 */
export function getMainWindow(): Window | null {
  return mainWindowRef;
}
