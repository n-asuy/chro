//! Image upload and serving endpoints (merged from api.rs).

use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Multipart, Path, Query, State},
    http::{header, StatusCode},
    response::Response,
    routing::{delete, get, post},
    Json, Router,
};
use chro_image::{ImageError, ImageService};
use db::models::asset_image::AssetImage;
use runtime::Runtime;
use serde::{Deserialize, Serialize};
use tokio::fs::File;
use tokio_util::io::ReaderStream;
use uuid::Uuid;

use crate::{ApiError, AppState, MAX_IMAGE_UPLOAD_BYTES};

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/images/upload",
            post(upload_image).layer(DefaultBodyLimit::max(MAX_IMAGE_UPLOAD_BYTES)),
        )
        .route("/images/metadata", get(get_image_metadata))
        .route("/images/:id/file", get(serve_image))
        .route("/images/:id", delete(delete_image))
}

#[derive(Debug, Serialize)]
pub(crate) struct ImageEnvelope {
    pub(crate) image: ImageResponse,
}

#[derive(Debug, Serialize)]
pub(crate) struct ImageListResponse {
    pub(crate) images: Vec<ImageResponse>,
}

#[derive(Debug, Serialize, Clone)]
pub(crate) struct ImageResponse {
    pub(crate) id: Uuid,
    pub(crate) file_path: String,
    pub(crate) original_name: String,
    pub(crate) mime_type: Option<String>,
    pub(crate) size_bytes: i32,
    pub(crate) hash: String,
    pub(crate) created_at: chrono::DateTime<chrono::Utc>,
    pub(crate) updated_at: chrono::DateTime<chrono::Utc>,
}

impl ImageResponse {
    pub(crate) fn from_asset(image: AssetImage, service: &ImageService) -> Self {
        Self {
            id: image.id,
            file_path: service.markdown_path(&image),
            original_name: image.original_name,
            mime_type: image.mime_type,
            size_bytes: image.size_bytes,
            hash: image.hash,
            created_at: image.created_at,
            updated_at: image.updated_at,
        }
    }
}

#[derive(Debug, Deserialize)]
struct MetadataQuery {
    path: String,
}

#[derive(Debug, Serialize)]
struct ImageMetadataResponse {
    exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    proxy_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    size_bytes: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    format: Option<String>,
}

async fn get_image_metadata(
    State(state): State<AppState>,
    Query(query): Query<MetadataQuery>,
) -> Result<Json<ImageMetadataResponse>, ApiError> {
    let image_service = state.runtime().image();
    match image_service.get_image_by_markdown_path(&query.path).await {
        Ok(image) => {
            let format = image
                .mime_type
                .as_ref()
                .and_then(|m| m.split('/').nth(1))
                .map(|s| s.to_string());
            Ok(Json(ImageMetadataResponse {
                exists: true,
                id: Some(image.id),
                path: Some(image_service.markdown_path(&image)),
                proxy_url: Some(format!("/rpc/images/{}/file", image.id)),
                file_name: Some(image.original_name),
                size_bytes: Some(image.size_bytes),
                format,
            }))
        }
        Err(ImageError::NotFound) => Ok(Json(ImageMetadataResponse {
            exists: false,
            id: None,
            path: None,
            proxy_url: None,
            file_name: None,
            size_bytes: None,
            format: None,
        })),
        Err(e) => Err(ApiError::Image(e)),
    }
}

async fn upload_image(
    State(state): State<AppState>,
    multipart: Multipart,
) -> Result<Json<ImageEnvelope>, ApiError> {
    let image = process_image_upload(&state, multipart, None).await?;
    Ok(Json(ImageEnvelope { image }))
}

async fn serve_image(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Response, ApiError> {
    let image_service = state.runtime().image();
    let image = image_service.get_image(id).await?;
    let path = image_service.get_cached_path(&image);
    let file = File::open(&path).await.map_err(|err| match err.kind() {
        std::io::ErrorKind::NotFound => ApiError::Image(ImageError::NotFound),
        _ => ApiError::BadRequest(format!("failed to open image: {err}")),
    })?;
    let metadata = file
        .metadata()
        .await
        .map_err(|err| ApiError::BadRequest(format!("failed to read image metadata: {err}")))?;

    let stream = ReaderStream::new(file);
    let body = Body::from_stream(stream);
    let content_type = image
        .mime_type
        .as_deref()
        .unwrap_or("application/octet-stream");

    let response = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_LENGTH, metadata.len())
        .header(header::CACHE_CONTROL, "public, max-age=31536000")
        .body(body)
        .map_err(|err| ApiError::BadRequest(format!("failed to build response: {err}")))?;

    Ok(response)
}

async fn delete_image(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    state.runtime().image().delete_image(id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) async fn process_image_upload(
    state: &AppState,
    mut multipart: Multipart,
    task_id: Option<Uuid>,
) -> Result<ImageResponse, ApiError> {
    let image_service = state.runtime().image();
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|err| ApiError::BadRequest(format!("invalid multipart data: {err}")))?
    {
        if field.name() != Some("image") {
            continue;
        }
        let filename = field
            .file_name()
            .map(|name| name.to_string())
            .unwrap_or_else(|| "upload.bin".to_string());
        let data = field
            .bytes()
            .await
            .map_err(|err| ApiError::BadRequest(format!("failed to read upload: {err}")))?;
        let stored = match task_id {
            Some(id) => {
                image_service
                    .store_and_link_task(data.as_ref(), &filename, id)
                    .await?
            }
            None => image_service.store_image(data.as_ref(), &filename).await?,
        };
        return Ok(ImageResponse::from_asset(stored, image_service));
    }

    Err(ApiError::BadRequest(
        "multipart field 'image' is required".into(),
    ))
}
