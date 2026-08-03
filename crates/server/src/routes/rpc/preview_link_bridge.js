/**
 * Link bridge for the HTML preview frame.
 *
 * The preview is an iframe pointed at the file-serving asset endpoint, so a
 * link to a sibling file navigates the frame away from the previewed document
 * and lands on raw bytes: a Markdown target renders as plain text, the editor
 * tab still names the original file, and nothing but a manual refresh gets the
 * preview back. This script reports link clicks to the embedding app instead,
 * which opens workspace files as editor tabs and hands remote URLs to the
 * system browser.
 *
 * The server appends it only to asset responses that opt in, so documents
 * fetched as sub-resources (nested frames, imports) stay untouched.
 */
(function () {
  var MESSAGE_TYPE = "chro:preview-link";
  // Everything else (javascript:, blob:, data:) acts on the document itself and
  // is left to the frame.
  var FORWARDED_PROTOCOLS = ["http:", "https:", "mailto:"];

  if (window.parent === window) return;

  // Bubble phase, so a document that routes its own links (and calls
  // preventDefault) keeps doing so; only clicks it left alone are forwarded.
  document.addEventListener(
    "click",
    function (event) {
      if (event.defaultPrevented || event.button !== 0) return;

      var target = event.target;
      var anchor = target && target.closest ? target.closest("a[href]") : null;
      if (!anchor) return;

      var href = (anchor.getAttribute("href") || "").trim();
      // A bare fragment scrolls within the previewed document; leave it alone.
      if (!href || href.charAt(0) === "#") return;

      var resolved;
      try {
        resolved = new URL(anchor.href, document.baseURI);
      } catch (error) {
        return;
      }
      if (FORWARDED_PROTOCOLS.indexOf(resolved.protocol) < 0) return;

      // Modifier clicks are forwarded too: their default here is the broken
      // in-frame navigation, not a useful new-tab gesture.
      event.preventDefault();
      window.parent.postMessage(
        {
          type: MESSAGE_TYPE,
          href: href,
          url: resolved.href,
          // Same origin means the target is served by the asset endpoint, so it
          // names a file in the workspace rather than a site on the web.
          local: resolved.origin === window.location.origin,
        },
        // The receiver is the app window itself, whose origin differs between
        // the packaged webview and the dev server. The payload carries nothing
        // that is not already in the previewed document.
        "*",
      );
    },
    false,
  );
})();
