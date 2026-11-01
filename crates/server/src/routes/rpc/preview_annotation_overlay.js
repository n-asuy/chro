/**
 * Annotation overlay for the HTML preview frame.
 *
 * While the embedding app has annotation mode on, this script outlines the
 * element under the pointer, asks for a comment when it is clicked, and
 * reports the element (a unique CSS selector, a short label, its visible text
 * and box) together with the comment. The app owns the list of notes and
 * sends back the selectors to pin, so the pins survive a reload of the
 * document.
 *
 * Everything the overlay draws lives in a closed shadow root on a fixed host
 * element, which keeps the page's styles out of the overlay and the overlay's
 * out of the page. While the mode is on, pointer input is captured before the
 * page sees it, so picking an element never follows a link, submits a form or
 * runs the page's own click handlers.
 *
 * Appended by the server next to the link bridge, under the same opt-in.
 */
(function () {
  var MESSAGE = {
    ready: "chro:annotate-ready",
    add: "chro:annotate-add",
    exit: "chro:annotate-exit",
    sync: "chro:annotate-sync",
  };
  var ACCENT = "#2f7cf6";
  var CURSOR_CLASS = "chro-annotating";
  var TEXT_LIMIT = 240;
  var NAME_LIMIT = 40;

  if (window.parent === window) return;

  var state = {
    active: false,
    pins: [],
    labels: {
      placeholder: "What should change?",
      add: "Add",
      cancel: "Cancel",
      hint: "⌘↵ to add",
    },
  };

  var host = null;
  var shadow = null;
  var hoverBox = null;
  var hoverLabel = null;
  var pinLayer = null;
  var popover = null;
  var frameRequest = 0;

  // --- Element description -------------------------------------------------

  function escapeIdent(value) {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(value);
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, function (ch) {
      return "\\" + ch;
    });
  }

  function isUnique(selector) {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch (error) {
      return false;
    }
  }

  // Generated or utility-heavy class names rarely survive an edit, so only
  // plain identifiers are used, and at most two of them.
  var PLAIN_CLASS = /^[A-Za-z_][A-Za-z0-9_-]*$/;

  function segmentFor(el) {
    if (el.id && isUnique("#" + escapeIdent(el.id))) {
      return { selector: "#" + escapeIdent(el.id), anchored: true };
    }
    var tag = el.localName;
    var testId = el.getAttribute("data-testid");
    if (testId) {
      return {
        selector: tag + '[data-testid="' + testId.replace(/"/g, '\\"') + '"]',
        anchored: false,
      };
    }
    var classes = Array.prototype.filter
      .call(el.classList, function (name) {
        return PLAIN_CLASS.test(name) && name !== CURSOR_CLASS;
      })
      .slice(0, 2);
    var selector = tag + classes.map(function (name) {
      return "." + escapeIdent(name);
    }).join("");
    var parent = el.parentElement;
    if (parent) {
      var twins = Array.prototype.filter.call(parent.children, function (child) {
        return child.localName === tag;
      });
      if (twins.length > 1) {
        selector += ":nth-of-type(" + (twins.indexOf(el) + 1) + ")";
      }
    }
    return { selector: selector, anchored: false };
  }

  // Walk up from the element until the joined path matches exactly one node,
  // stopping early at an ancestor with a unique id.
  function uniqueSelector(el) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      var segment = segmentFor(node);
      parts.unshift(segment.selector);
      var joined = parts.join(" > ");
      if (segment.anchored || isUnique(joined)) return joined;
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  function collapse(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function accessibleName(el) {
    return collapse(
      el.getAttribute("aria-label") ||
        el.getAttribute("alt") ||
        el.getAttribute("title") ||
        el.innerText ||
        el.textContent,
    );
  }

  function elementLabel(el) {
    var name = accessibleName(el);
    if (!name) return el.localName;
    if (name.length > NAME_LIMIT) name = name.slice(0, NAME_LIMIT) + "…";
    return el.localName + ' "' + name + '"';
  }

  function describe(el) {
    var rect = el.getBoundingClientRect();
    var note = {
      selector: uniqueSelector(el),
      element: elementLabel(el),
      rect: {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      },
      comment: "",
    };
    var text = collapse(el.innerText || el.textContent).slice(0, TEXT_LIMIT);
    if (text) note.text = text;
    return note;
  }

  // --- Overlay DOM -----------------------------------------------------------

  var STYLE =
    ":host{all:initial}" +
    ".layer{position:fixed;inset:0;pointer-events:none;font:12px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI','Hiragino Sans','Noto Sans JP',sans-serif}" +
    ".hover{position:fixed;display:none;border:1.5px solid " + ACCENT + ";background:rgba(47,124,246,.08);border-radius:3px}" +
    ".label{position:fixed;display:none;transform:translateY(-100%);margin-top:-3px;padding:2px 6px;border-radius:4px;background:" + ACCENT + ";color:#fff;font:600 10.5px/1.5 ui-monospace,'SF Mono',Menlo,monospace;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis}" +
    ".pin-box{position:fixed;border:1.5px dashed rgba(47,124,246,.75);border-radius:3px}" +
    ".pin{position:fixed;width:20px;height:20px;margin:-10px 0 0 -10px;border-radius:50%;background:" + ACCENT + ";color:#fff;font:700 10.5px/20px -apple-system,sans-serif;text-align:center;box-shadow:0 1px 2px rgba(0,0,0,.25)}" +
    ".pop{position:fixed;width:280px;padding:8px;border-radius:10px;background:#fff;color:#1d2433;border:1px solid #dfe3ea;box-shadow:0 1px 2px rgba(0,0,0,.10),0 3px 8px rgba(0,0,0,.07);pointer-events:auto}" +
    ".what{margin:0 2px 6px;color:#5b6478;font:11px/1.4 ui-monospace,'SF Mono',Menlo,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
    "textarea{box-sizing:border-box;display:block;width:100%;height:64px;resize:none;border:1px solid #dfe3ea;border-radius:6px;padding:6px 8px;font:13px/1.45 -apple-system,BlinkMacSystemFont,'Hiragino Sans','Noto Sans JP',sans-serif;color:#1d2433;background:#fff;outline:none}" +
    "textarea:focus{border-color:#6b97ff}" +
    ".row{display:flex;align-items:center;justify-content:flex-end;gap:6px;margin-top:6px}" +
    ".hint{margin-right:auto;color:#8a92a3;font-size:11px}" +
    "button{height:26px;padding:0 10px;border:0;border-radius:6px;font:12px -apple-system,BlinkMacSystemFont,sans-serif;cursor:pointer}" +
    ".ok{background:#1d2433;color:#fff}" +
    ".cancel{background:transparent;color:#5b6478}";

  function ensureOverlay() {
    if (host) return;
    host = document.createElement("chro-annotation-overlay");
    host.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:block";
    shadow = host.attachShadow({ mode: "closed" });
    var style = document.createElement("style");
    style.textContent = STYLE;
    var layer = document.createElement("div");
    layer.className = "layer";
    pinLayer = document.createElement("div");
    hoverBox = document.createElement("div");
    hoverBox.className = "hover";
    hoverLabel = document.createElement("div");
    hoverLabel.className = "label";
    layer.appendChild(pinLayer);
    layer.appendChild(hoverBox);
    layer.appendChild(hoverLabel);
    shadow.appendChild(style);
    shadow.appendChild(layer);
    document.documentElement.appendChild(host);

    var cursorStyle = document.createElement("style");
    cursorStyle.textContent =
      "html." + CURSOR_CLASS + ",html." + CURSOR_CLASS + " *{cursor:crosshair!important}";
    document.documentElement.appendChild(cursorStyle);
  }

  function place(node, rect) {
    node.style.left = rect.left + "px";
    node.style.top = rect.top + "px";
    node.style.width = rect.width + "px";
    node.style.height = rect.height + "px";
  }

  function hideHover() {
    if (!hoverBox) return;
    hoverBox.style.display = "none";
    hoverLabel.style.display = "none";
  }

  function showHover(el) {
    var rect = el.getBoundingClientRect();
    place(hoverBox, rect);
    hoverBox.style.display = "block";
    hoverLabel.style.left = rect.left + "px";
    hoverLabel.style.top = Math.max(rect.top, 18) + "px";
    hoverLabel.textContent =
      segmentFor(el).selector +
      "  " +
      Math.round(rect.width) +
      "×" +
      Math.round(rect.height);
    hoverLabel.style.display = "block";
  }

  function renderPins() {
    if (!pinLayer) return;
    pinLayer.textContent = "";
    state.pins.forEach(function (pin, index) {
      var el = null;
      try {
        el = document.querySelector(pin.selector);
      } catch (error) {
        el = null;
      }
      if (!el) return;
      var rect = el.getBoundingClientRect();
      var box = document.createElement("div");
      box.className = "pin-box";
      place(box, rect);
      var dot = document.createElement("div");
      dot.className = "pin";
      dot.textContent = String(index + 1);
      dot.style.left = rect.right + "px";
      dot.style.top = rect.top + "px";
      pinLayer.appendChild(box);
      pinLayer.appendChild(dot);
    });
  }

  // Pins follow their elements through scrolling, resizing and layout shifts;
  // the loop only runs while there is something to draw.
  function schedule() {
    if (frameRequest) return;
    frameRequest = window.requestAnimationFrame(function tick() {
      frameRequest = 0;
      renderPins();
      if (state.active || state.pins.length) schedule();
    });
  }

  // --- Comment popover -------------------------------------------------------

  function closePopover() {
    if (!popover) return;
    popover.remove();
    popover = null;
  }

  function openPopover(el) {
    closePopover();
    var note = describe(el);
    var rect = el.getBoundingClientRect();

    popover = document.createElement("div");
    popover.className = "pop";
    var what = document.createElement("div");
    what.className = "what";
    what.textContent = note.selector;
    var input = document.createElement("textarea");
    input.placeholder = state.labels.placeholder;
    var row = document.createElement("div");
    row.className = "row";
    var hint = document.createElement("span");
    hint.className = "hint";
    hint.textContent = state.labels.hint;
    var cancel = document.createElement("button");
    cancel.className = "cancel";
    cancel.type = "button";
    cancel.textContent = state.labels.cancel;
    var ok = document.createElement("button");
    ok.className = "ok";
    ok.type = "button";
    ok.textContent = state.labels.add;
    row.appendChild(hint);
    row.appendChild(cancel);
    row.appendChild(ok);
    popover.appendChild(what);
    popover.appendChild(input);
    popover.appendChild(row);
    shadow.querySelector(".layer").appendChild(popover);

    var width = 280;
    var height = popover.offsetHeight || 130;
    var left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
    var below = rect.bottom + 8;
    var top =
      below + height <= window.innerHeight
        ? below
        : Math.max(8, rect.top - height - 8);
    popover.style.left = left + "px";
    popover.style.top = top + "px";

    function submit() {
      var comment = input.value.trim();
      if (!comment) {
        input.focus();
        return;
      }
      note.comment = comment;
      window.parent.postMessage(
        {
          type: MESSAGE.add,
          note: note,
          viewport: { width: window.innerWidth, height: window.innerHeight },
        },
        // The receiver is the app window, whose origin differs between the
        // packaged webview and the dev server. The payload only repeats what
        // the user typed and what the document already shows.
        "*",
      );
      closePopover();
    }

    ok.addEventListener("click", submit);
    cancel.addEventListener("click", closePopover);
    input.addEventListener("keydown", function (event) {
      event.stopPropagation();
      if (event.isComposing) return;
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        submit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        closePopover();
      }
    });
    input.focus();
  }

  // --- Input capture ---------------------------------------------------------

  function fromOverlay(event) {
    return !!host && event.composedPath().indexOf(host) >= 0;
  }

  function pickable(target) {
    if (!target || target.nodeType !== 1) return null;
    if (target === document.documentElement || target === document.body) {
      return null;
    }
    return target;
  }

  function onPointerMove(event) {
    if (!state.active || popover || fromOverlay(event)) {
      hideHover();
      return;
    }
    var el = pickable(event.target);
    if (el) showHover(el);
    else hideHover();
  }

  // Swallow the press itself too, so the page neither focuses a field nor
  // starts a drag or text selection under the pointer.
  function onPress(event) {
    if (!state.active || fromOverlay(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function onClick(event) {
    if (!state.active || fromOverlay(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    var el = pickable(event.target);
    if (!el) return;
    hideHover();
    openPopover(el);
  }

  function onKeyDown(event) {
    if (!state.active || event.key !== "Escape" || event.isComposing) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (popover) {
      closePopover();
      return;
    }
    window.parent.postMessage({ type: MESSAGE.exit }, "*");
  }

  ["pointerdown", "mousedown", "pointerup", "mouseup", "dblclick", "auxclick"].forEach(
    function (type) {
      window.addEventListener(type, onPress, true);
    },
  );
  window.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("click", onClick, true);
  window.addEventListener("keydown", onKeyDown, true);

  // --- App messages ----------------------------------------------------------

  function applySync(data) {
    state.active = data.active === true;
    state.pins = Array.isArray(data.pins)
      ? data.pins.filter(function (pin) {
          return pin && typeof pin.selector === "string";
        })
      : [];
    if (data.labels && typeof data.labels === "object") {
      ["placeholder", "add", "cancel", "hint"].forEach(function (key) {
        if (typeof data.labels[key] === "string") state.labels[key] = data.labels[key];
      });
    }
    ensureOverlay();
    document.documentElement.classList.toggle(CURSOR_CLASS, state.active);
    if (!state.active) {
      closePopover();
      hideHover();
    }
    renderPins();
    schedule();
  }

  window.addEventListener("message", function (event) {
    // Only the embedding app may drive the overlay; the page's own scripts
    // and nested frames are ignored.
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || typeof data !== "object" || data.type !== MESSAGE.sync) return;
    applySync(data);
  });

  window.parent.postMessage({ type: MESSAGE.ready }, "*");
})();
