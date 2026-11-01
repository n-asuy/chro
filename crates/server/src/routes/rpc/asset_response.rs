//! Responses for the path-based asset endpoints that back the HTML preview.
//!
//! These endpoints exist so that relative references inside a served document
//! (`<link href="style.css">`, `<img src="../img/a.png">`) resolve to sibling
//! files through the same URL hierarchy. That same property makes a plain
//! `<a href="notes/todo.md">` navigate the preview frame onto the raw bytes of
//! another file, stranding the user outside the editor. Documents requested by
//! the preview frame therefore opt in to the preview bridge: a script that
//! reports link clicks back to the app instead (`preview_link_bridge.js`) and
//! the overlay that lets the user comment on elements of the rendered page
//! (`preview_annotation_overlay.js`).

use axum::{
    body::{Body, Bytes},
    http::{header, HeaderMap, StatusCode},
    response::Response,
};
use filesystem::WorkspaceBinaryFile;
use futures::{stream, StreamExt};
use serde::Deserialize;
use tokio::fs::File;
use tokio_util::io::ReaderStream;

use super::path_resolve::stream_binary_response;
use crate::ApiError;

/// Assets are edited live and re-read on every preview refresh, so they must
/// never be served from the webview cache.
pub(crate) const ASSET_CACHE_CONTROL: &str = "no-cache";

/// The bridge scripts, wrapped so they can be appended to a served document. A
/// trailing script element outside `</html>` is parsed into the document body
/// by every browser engine, which keeps the original bytes untouched. Each
/// script gets its own element so a failure in one cannot stop the other.
const PREVIEW_BRIDGE_SUFFIX: &str = concat!(
    "\n<script>\n",
    include_str!("preview_link_bridge.js"),
    "</script>\n<script>\n",
    include_str!("preview_annotation_overlay.js"),
    "</script>\n"
);

/// Query parameters accepted by the asset endpoints. Unknown parameters (the
/// cache-busting `_v` / `_r` the client appends) are ignored.
#[derive(Debug, Default, Deserialize)]
pub(crate) struct AssetQuery {
    /// Set by the preview frame for the top-level document only. Sub-resource
    /// requests omit it and are served verbatim.
    #[serde(default)]
    preview_bridge: Option<String>,
}

impl AssetQuery {
    fn wants_preview_bridge(&self) -> bool {
        matches!(self.preview_bridge.as_deref(), Some("1") | Some("true"))
    }
}

/// Whether a MIME type names an HTML document, ignoring parameters and case
/// (`text/html; charset=utf-8`).
fn is_html(mime_type: &str) -> bool {
    mime_type
        .split(';')
        .next()
        .is_some_and(|essence| essence.trim().eq_ignore_ascii_case("text/html"))
}

/// Serve an asset, appending the preview bridge when the request opted in and
/// the file is an HTML document.
pub(crate) async fn stream_asset_response(
    binary_file: WorkspaceBinaryFile,
    query: &AssetQuery,
    request_headers: &HeaderMap,
) -> Result<Response, ApiError> {
    if query.wants_preview_bridge() && is_html(&binary_file.mime_type) {
        return stream_with_suffix(binary_file, PREVIEW_BRIDGE_SUFFIX).await;
    }
    stream_binary_response(binary_file, ASSET_CACHE_CONTROL, request_headers).await
}

/// Stream the file followed by `suffix`. The suffix is a fixed-size tail, so
/// the response keeps an exact `Content-Length` and stays streamed rather than
/// buffering the document to concatenate it.
async fn stream_with_suffix(
    binary_file: WorkspaceBinaryFile,
    suffix: &'static str,
) -> Result<Response, ApiError> {
    let file = File::open(&binary_file.path)
        .await
        .map_err(filesystem::FilesystemError::Io)?;
    let size = file
        .metadata()
        .await
        .map_err(filesystem::FilesystemError::Io)?
        .len();
    let tail =
        stream::once(async move { Ok::<_, std::io::Error>(Bytes::from_static(suffix.as_bytes())) });
    let body = Body::from_stream(ReaderStream::new(file).chain(tail));

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, binary_file.mime_type)
        .header(header::CONTENT_LENGTH, size + suffix.len() as u64)
        .header(header::CACHE_CONTROL, ASSET_CACHE_CONTROL)
        .body(body)
        .map_err(|error| ApiError::Internal(format!("failed to build asset response: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn query(preview_bridge: Option<&str>) -> AssetQuery {
        AssetQuery {
            preview_bridge: preview_bridge.map(str::to_string),
        }
    }

    fn html_file(path: PathBuf, size: u64) -> WorkspaceBinaryFile {
        WorkspaceBinaryFile {
            relative_path: "index.html".to_string(),
            path,
            size,
            mime_type: "text/html".to_string(),
            modified: None,
        }
    }

    async fn body_string(response: Response) -> String {
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("collect body");
        String::from_utf8(bytes.to_vec()).expect("utf-8 body")
    }

    #[test]
    fn only_the_explicit_opt_in_requests_the_bridge() {
        assert!(query(Some("1")).wants_preview_bridge());
        assert!(query(Some("true")).wants_preview_bridge());
        assert!(!query(Some("0")).wants_preview_bridge());
        assert!(!query(None).wants_preview_bridge());
    }

    #[test]
    fn html_is_detected_through_parameters_and_case() {
        assert!(is_html("text/html"));
        assert!(is_html("text/html; charset=utf-8"));
        assert!(is_html("TEXT/HTML"));
        assert!(!is_html("text/plain; charset=utf-8"));
        assert!(!is_html("application/xhtml+xml"));
    }

    /// Each script is embedded inside its own `<script>` element, so no
    /// script body may contain a closing tag that would terminate it early.
    #[test]
    fn bridge_suffix_is_two_self_contained_script_elements() {
        let bodies: Vec<&str> = PREVIEW_BRIDGE_SUFFIX
            .split("<script>")
            .skip(1)
            .map(|rest| rest.split("</script>").next().expect("closing tag"))
            .collect();
        assert_eq!(bodies.len(), 2);
        assert_eq!(PREVIEW_BRIDGE_SUFFIX.matches("</script").count(), 2);
        assert!(bodies[0].contains("chro:preview-link"));
        assert!(bodies[1].contains("chro:annotate-sync"));
    }

    /// The opted-in HTML document keeps its own bytes and gains the bridge, and
    /// the declared length covers both parts — a short `Content-Length` would
    /// truncate the script mid-parse.
    #[tokio::test]
    async fn html_opt_in_appends_the_bridge_and_declares_the_full_length() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("index.html");
        let source = "<html><body><a href=\"notes/todo.md\">todo</a></body></html>";
        std::fs::write(&path, source).expect("write html");

        let response = stream_asset_response(
            html_file(path, source.len() as u64),
            &query(Some("1")),
            &HeaderMap::new(),
        )
        .await
        .expect("response");

        let content_length: u64 = response
            .headers()
            .get(header::CONTENT_LENGTH)
            .expect("content-length")
            .to_str()
            .expect("ascii")
            .parse()
            .expect("number");
        assert_eq!(
            content_length,
            (source.len() + PREVIEW_BRIDGE_SUFFIX.len()) as u64
        );

        let body = body_string(response).await;
        assert!(body.starts_with(source));
        assert!(body.ends_with(PREVIEW_BRIDGE_SUFFIX));
    }

    /// Sub-resource requests carry no opt-in, so the document is served byte
    /// for byte — a nested frame must not get a second bridge posting to the
    /// wrong window.
    #[tokio::test]
    async fn html_without_opt_in_is_served_verbatim() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("nested.html");
        let source = "<html><body>nested</body></html>";
        std::fs::write(&path, source).expect("write html");

        let response = stream_asset_response(
            html_file(path, source.len() as u64),
            &query(None),
            &HeaderMap::new(),
        )
        .await
        .expect("response");

        assert_eq!(body_string(response).await, source);
    }

    /// Only HTML is instrumented: appending a script to a stylesheet, image, or
    /// Markdown file would corrupt it.
    #[tokio::test]
    async fn non_html_is_served_verbatim_even_with_opt_in() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("notes.md");
        let source = "# heading\n";
        std::fs::write(&path, source).expect("write markdown");

        let mut binary_file = html_file(path, source.len() as u64);
        binary_file.relative_path = "notes.md".to_string();
        binary_file.mime_type = "text/plain; charset=utf-8".to_string();

        let response = stream_asset_response(binary_file, &query(Some("1")), &HeaderMap::new())
            .await
            .expect("response");

        assert_eq!(body_string(response).await, source);
    }
}
