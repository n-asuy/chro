export const SESSION_SELECT_SCOPE_ATTR = "data-session-select-scope";
export const SESSION_SELECT_ACTIVE_ATTR = "data-session-select-active";
export const SESSION_SELECT_TEXT_ATTR = "data-session-select-text";

const SESSION_SELECT_TEXT_SELECTOR = `[${SESSION_SELECT_TEXT_ATTR}="true"]`;

let activeScope: HTMLElement | null = null;

const toElement = (target: EventTarget | null): Element | null => {
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
};

export const activateSessionSelectScope = (scope: HTMLElement | null): void => {
  if (scope) {
    activeScope = scope;
  }
};

export const clearSessionSelectState = (scope?: HTMLElement | null): void => {
  const targetScope = scope ?? activeScope;
  targetScope?.removeAttribute(SESSION_SELECT_ACTIVE_ATTR);
  if (!scope || activeScope === scope) {
    activeScope = null;
  }
};

export const clearSessionSelectHighlight = (
  scope?: HTMLElement | null,
): void => {
  const targetScope = scope ?? activeScope;
  targetScope?.removeAttribute(SESSION_SELECT_ACTIVE_ATTR);
};

export const isSelectAllShortcut = (event: KeyboardEvent): boolean =>
  event.key.toLowerCase() === "a" &&
  (event.metaKey || event.ctrlKey) &&
  !event.altKey &&
  !event.shiftKey;

export const shouldUseNativeSelectAll = (
  target: EventTarget | null,
): boolean => {
  const element = toElement(target);
  if (!element) return false;

  const nativeInput = element.closest("input,textarea,select");
  if (nativeInput) return true;

  const editable = element.closest<HTMLElement>(
    "[contenteditable]:not([contenteditable='false']),[role='textbox']",
  );
  if (!editable) return false;

  return (editable.textContent ?? "").replace(/\u200B/g, "").trim().length > 0;
};

const getCurrentActiveScope = (): HTMLElement | null => {
  if (activeScope?.isConnected) return activeScope;
  activeScope = null;
  return null;
};

export const selectActiveSessionMessages = (): boolean => {
  const currentActiveScope = getCurrentActiveScope();
  return currentActiveScope ? selectSessionMessages(currentActiveScope) : false;
};

export const shouldSelectSessionMessages = (
  event: KeyboardEvent,
  scope: HTMLElement,
): boolean => {
  const currentActiveScope = getCurrentActiveScope();
  if (currentActiveScope && currentActiveScope !== scope) {
    return false;
  }

  const target = toElement(event.target);
  if (target && scope.contains(target)) return true;

  const activeElement = scope.ownerDocument.activeElement;
  if (activeElement && scope.contains(activeElement)) return true;

  const documentTarget =
    !target ||
    target === scope.ownerDocument.body ||
    target === scope.ownerDocument.documentElement;

  return documentTarget || currentActiveScope === scope;
};

const isHidden = (element: HTMLElement): boolean => {
  if (element.closest("[hidden],[aria-hidden='true']")) return true;

  const view = element.ownerDocument.defaultView;
  if (!view) return false;

  const style = view.getComputedStyle(element);
  return style.display === "none" || style.visibility === "hidden";
};

export const getSelectableMessageElements = (
  scope: HTMLElement,
): HTMLElement[] =>
  Array.from(
    scope.querySelectorAll<HTMLElement>(SESSION_SELECT_TEXT_SELECTOR),
  ).filter((element) => !isHidden(element));

const getRenderedText = (element: HTMLElement): string => {
  const text =
    typeof element.innerText === "string"
      ? element.innerText
      : element.textContent;
  return (text ?? "").replace(/\u00a0/g, " ").trim();
};

export const getSelectedSessionText = (scope: HTMLElement): string =>
  getSelectableMessageElements(scope)
    .map(getRenderedText)
    .filter(Boolean)
    .join("\n\n");

const rangeTouchesScope = (range: Range, scope: HTMLElement): boolean => {
  const startElement =
    range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
  const endElement =
    range.endContainer instanceof Element
      ? range.endContainer
      : range.endContainer.parentElement;

  return Boolean(
    (startElement && scope.contains(startElement)) ||
      (endElement && scope.contains(endElement)) ||
      scope.contains(range.commonAncestorContainer),
  );
};

export const selectionTouchesScope = (
  selection: Selection | null,
  scope: HTMLElement,
): boolean => {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return false;
  }

  for (let index = 0; index < selection.rangeCount; index++) {
    if (rangeTouchesScope(selection.getRangeAt(index), scope)) return true;
  }

  return false;
};

export const selectSessionMessages = (
  scope: HTMLElement,
  selection: Selection | null = scope.ownerDocument.defaultView?.getSelection() ??
    null,
): boolean => {
  const elements = getSelectableMessageElements(scope);
  if (!selection || elements.length === 0) return false;

  const first = elements[0];
  const last = elements[elements.length - 1];
  if (!first || !last) return false;

  const range = scope.ownerDocument.createRange();
  range.setStartBefore(first);
  range.setEndAfter(last);

  clearSessionSelectState();
  activeScope = scope;
  scope.setAttribute(SESSION_SELECT_ACTIVE_ATTR, "true");

  selection.removeAllRanges();
  selection.addRange(range);
  return true;
};
