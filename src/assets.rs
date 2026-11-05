use axum::http::{StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use rust_embed::RustEmbed;

/// The built frontend. Debug builds read it from disk at request time, so
/// `npm run watch` in web/ is picked up without recompiling.
#[derive(RustEmbed)]
#[folder = "web/dist/"]
#[allow_missing = true]
struct Assets;

/// The app's page, with `theme` on its `<html>` element.
pub fn index(theme: &str) -> Response {
    let Some(file) = Assets::get("index.html") else {
        return (StatusCode::NOT_FOUND, "frontend not built: run `make web`").into_response();
    };
    let html = String::from_utf8_lossy(&file.data).replacen(
        "<html",
        &format!("<html data-theme=\"{theme}\""),
        1,
    );
    (
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        html,
    )
        .into_response()
}

pub async fn serve(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let Some(file) = Assets::get(path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // Vite puts a content hash in every file name under assets/, so those never change.
    let cache = if path.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    let mime = file.metadata.mimetype().to_string();
    (
        [
            (header::CONTENT_TYPE, mime),
            (header::CACHE_CONTROL, cache.to_string()),
        ],
        file.data,
    )
        .into_response()
}
