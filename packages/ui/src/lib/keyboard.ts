/**
 * Shared keyboard utilities for @stoneforge/ui components.
 *
 * Mirrors the editable-target check used by quarry-web's
 * KeyboardShortcutManager (apps/quarry-web/src/lib/keyboard.ts); kept as a
 * separate copy because packages/ui cannot import from an app.
 */

/**
 * True when an event target is a text-entry surface: <input>, <textarea>,
 * or a contenteditable element (rich-text editors such as TipTap/ProseMirror
 * use a contenteditable <div>, not an input).
 *
 * Global single-key shortcuts ("/" to focus search, "j"/"k" navigation, ...)
 * must not fire — and especially must not preventDefault — for these
 * targets, or they steal keystrokes from the editor. This is exactly how
 * the slash-command menu broke on the documents page: a search bar's "/"
 * listener preventDefault-ed the "/" typed into the block editor and moved
 * focus to the search box, so the menu could never open.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
}
