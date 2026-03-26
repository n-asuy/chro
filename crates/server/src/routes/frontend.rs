use axum::{
    body::Body,
    extract::Request,
    http::{header, HeaderValue, StatusCode},
    response::Response,
};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "../../apps/desktop/dist-vite"]
struct Assets;

pub(crate) async fn serve_fallback(req: Request) -> Response {
    let path = req.uri().path().trim_start_matches('/');
    if path.is_empty() {
        return serve_file("index.html");
    }
    serve_file(path)
}

fn serve_file(path: &str) -> Response {
    if let Some(content) = Assets::get(path) {
        let mime = mime_guess::from_path(path).first_or_octet_stream();
        Response::builder()
            .status(StatusCode::OK)
            .header(
                header::CONTENT_TYPE,
                HeaderValue::from_str(mime.as_ref()).unwrap(),
            )
            .body(Body::from(content.data.into_owned()))
            .unwrap()
    } else if let Some(index) = Assets::get("index.html") {
        // SPA fallback: serve index.html for client-side routes
        Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, HeaderValue::from_static("text/html"))
            .body(Body::from(index.data.into_owned()))
            .unwrap()
    } else {
        Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::from("404 Not Found"))
            .unwrap()
    }
}
