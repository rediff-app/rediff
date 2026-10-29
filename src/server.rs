use std::collections::HashMap;
use std::convert::Infallible;
use std::num::NonZeroUsize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::Result;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{Query, Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::get;
use lru::LruCache;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::{Stream, StreamExt};
use tower_http::compression::{CompressionLayer, CompressionLevel};

use crate::assets;
use crate::git::{Commit, FileEntry, Repo, Spec};
use crate::patch;

/// Upper bound for serialized diffs kept in memory.
const CACHE_BYTES: usize = 128 << 20;
/// File listings of recently viewed commits.
const COMMIT_LISTINGS: NonZeroUsize = NonZeroUsize::new(16).unwrap();
/// Most commits the client may ask for at once; it asks for more page by page.
const MAX_COMMITS: usize = 10_000;

pub struct AppState {
    pub repo: Repo,
    pub token: String,
    /// Without a watcher, every file list request recomputes the listing.
    watching: bool,
    /// Cookies are shared across ports, so each instance gets its own name.
    cookie: String,
    /// Bumped by the watcher; a listing from an older generation is stale.
    generation: AtomicU64,
    listing: tokio::sync::Mutex<Option<Arc<Listing>>>,
    /// Commits never change, so neither do their listings.
    commit_listings: tokio::sync::Mutex<LruCache<String, Arc<Listing>>>,
    commit_log: tokio::sync::Mutex<Option<CommitLog>>,
    cache: Mutex<DiffCache>,
    events: broadcast::Sender<u64>,
}

pub struct Listing {
    generation: u64,
    spec: Spec,
    files: Vec<FileEntry>,
    by_path: HashMap<String, usize>,
    json: Bytes,
}

#[derive(Serialize)]
struct ListingBody<'a> {
    title: &'a str,
    files: &'a [FileEntry],
}

/// The last commit list served; still valid while HEAD stays put.
struct CommitLog {
    head: Option<String>,
    limit: usize,
    json: Bytes,
}

#[derive(Serialize)]
struct CommitsBody<'a> {
    /// Title of the diff given on the command line.
    base: &'a str,
    commits: &'a [Commit],
    /// There are older commits than these.
    more: bool,
}

impl AppState {
    pub fn new(repo: Repo, token: String, port: u16, watching: bool) -> Self {
        AppState {
            repo,
            token,
            watching,
            cookie: format!("rediff_{port}"),
            generation: AtomicU64::new(0),
            listing: tokio::sync::Mutex::new(None),
            commit_listings: tokio::sync::Mutex::new(LruCache::new(COMMIT_LISTINGS)),
            commit_log: tokio::sync::Mutex::new(None),
            cache: Mutex::new(DiffCache {
                map: LruCache::unbounded(),
                bytes: 0,
            }),
            events: broadcast::channel(16).0,
        }
    }

    /// The current file listing. Concurrent callers share one git invocation.
    pub async fn listing(&self) -> Result<Arc<Listing>> {
        let mut slot = self.listing.lock().await;
        let generation = self.generation.load(Ordering::Acquire);
        if let Some(l) = slot.as_ref().filter(|l| l.generation == generation) {
            return Ok(l.clone());
        }
        let l = self
            .build_listing(self.repo.base.clone(), generation)
            .await?;
        *slot = Some(l.clone());
        Ok(l)
    }

    /// The file listing of one commit against its parent.
    async fn commit_listing(&self, id: &str) -> Result<Arc<Listing>> {
        let mut cache = self.commit_listings.lock().await;
        if let Some(l) = cache.get(id) {
            return Ok(l.clone());
        }
        let spec = self.repo.commit_spec(id).await?;
        let l = self.build_listing(spec, 0).await?;
        cache.put(id.to_string(), l.clone());
        Ok(l)
    }

    /// The listing of a commit, or of the command line's diff when there is none.
    async fn listing_for(&self, commit: Option<&str>) -> Result<Arc<Listing>> {
        match commit {
            Some(id) => self.commit_listing(id).await,
            None => self.listing().await,
        }
    }

    async fn build_listing(&self, spec: Spec, generation: u64) -> Result<Arc<Listing>> {
        let files = self.repo.list_files(&spec).await?;
        let json = serde_json::to_vec(&ListingBody {
            title: &spec.title,
            files: &files,
        })?
        .into();
        let by_path = files
            .iter()
            .enumerate()
            .map(|(i, f)| (f.path.clone(), i))
            .collect();
        Ok(Arc::new(Listing {
            generation,
            spec,
            files,
            by_path,
            json,
        }))
    }

    /// The newest `limit` commits of the current branch, as JSON.
    async fn commit_log(&self, limit: usize) -> Result<Bytes> {
        let mut slot = self.commit_log.lock().await;
        let head = self.repo.head().await?;
        if let Some(c) = slot.as_ref().filter(|c| c.head == head && c.limit == limit) {
            return Ok(c.json.clone());
        }
        let mut commits = match &head {
            Some(head) => self.repo.commits(head, limit + 1).await?,
            None => Vec::new(),
        };
        let more = commits.len() > limit;
        commits.truncate(limit);
        let json: Bytes = serde_json::to_vec(&CommitsBody {
            base: &self.repo.base.title,
            commits: &commits,
            more,
        })?
        .into();
        *slot = Some(CommitLog {
            head,
            limit,
            json: json.clone(),
        });
        Ok(json)
    }

    /// Called by the watcher when the working tree, index or refs changed.
    pub fn changed(&self) {
        let generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        let _ = self.events.send(generation);
    }
}

/// Serialized diffs keyed by path and version, bounded by total size.
struct DiffCache {
    map: LruCache<String, Bytes>,
    bytes: usize,
}

impl DiffCache {
    fn get(&mut self, key: &str) -> Option<Bytes> {
        self.map.get(key).cloned()
    }

    fn put(&mut self, key: String, value: Bytes) {
        self.bytes += value.len();
        if let Some(old) = self.map.put(key, value) {
            self.bytes -= old.len();
        }
        while self.bytes > CACHE_BYTES {
            let Some((_, v)) = self.map.pop_lru() else {
                break;
            };
            self.bytes -= v.len();
        }
    }
}

pub fn router(state: Arc<AppState>) -> Router {
    let api = Router::new()
        .route("/api/files", get(files))
        .route("/api/diff", get(diff))
        .route("/api/commits", get(commits))
        .route("/api/events", get(events))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_auth));
    Router::new()
        .merge(api)
        .route("/auth", get(auth))
        .fallback(assets::serve)
        // Fast levels: on a local connection CPU time matters more than bytes.
        .layer(CompressionLayer::new().quality(CompressionLevel::Precise(4)))
        .with_state(state)
}

#[derive(Deserialize)]
struct FilesQuery {
    /// Show this commit instead of the command line's diff.
    commit: Option<String>,
}

async fn files(
    State(st): State<Arc<AppState>>,
    Query(q): Query<FilesQuery>,
) -> Result<Response, AppError> {
    if !st.watching && q.commit.is_none() {
        st.generation.fetch_add(1, Ordering::AcqRel);
    }
    let l = st.listing_for(q.commit.as_deref()).await?;
    Ok(json_no_store(l.json.clone()))
}

#[derive(Deserialize)]
struct CommitsQuery {
    limit: Option<usize>,
}

async fn commits(
    State(st): State<Arc<AppState>>,
    Query(q): Query<CommitsQuery>,
) -> Result<Response, AppError> {
    let limit = q.limit.unwrap_or(100).clamp(1, MAX_COMMITS);
    Ok(json_no_store(st.commit_log(limit).await?))
}

fn json_no_store(body: Bytes) -> Response {
    (
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        body,
    )
        .into_response()
}

#[derive(Deserialize)]
struct DiffQuery {
    path: String,
    /// The version the client expects, from the listing.
    v: Option<String>,
    commit: Option<String>,
}

async fn diff(
    State(st): State<Arc<AppState>>,
    Query(q): Query<DiffQuery>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let l = st.listing_for(q.commit.as_deref()).await?;
    let Some(f) = l.by_path.get(&q.path).map(|&i| &l.files[i]) else {
        return Ok((StatusCode::NOT_FOUND, "file is not part of the diff").into_response());
    };

    let etag = format!("\"{}\"", f.version);
    // The browser may only keep the response under this URL if the URL names this exact version.
    let cache_control = match (q.v.as_deref() == Some(f.version.as_str()), f.immutable) {
        (false, _) => "no-store",
        (true, true) => "private, max-age=31536000, immutable",
        (true, false) => "no-cache",
    };
    let cache_headers = [
        (header::ETAG, etag.clone()),
        (header::CACHE_CONTROL, cache_control.to_string()),
    ];
    if headers
        .get(header::IF_NONE_MATCH)
        .is_some_and(|v| v.as_bytes() == etag.as_bytes())
    {
        return Ok((StatusCode::NOT_MODIFIED, cache_headers).into_response());
    }

    let key = format!("{}\0{}", f.path, f.version);
    let cached = st.cache.lock().unwrap().get(&key);
    let body = match cached {
        Some(body) => body,
        None => {
            let raw = st.repo.file_patch(&l.spec, f).await?;
            let body: Bytes =
                tokio::task::spawn_blocking(move || serde_json::to_vec(&patch::parse(&raw)))
                    .await??
                    .into();
            st.cache.lock().unwrap().put(key, body.clone());
            body
        }
    };
    Ok((
        [(header::CONTENT_TYPE, "application/json".to_string())],
        cache_headers,
        body,
    )
        .into_response())
}

async fn events(
    State(st): State<Arc<AppState>>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    // A lagged receiver just means several changes were merged into one notification.
    let stream = BroadcastStream::new(st.events.subscribe()).map(|g| {
        Ok(Event::default()
            .event("change")
            .data(g.map(|g| g.to_string()).unwrap_or_default()))
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

#[derive(Deserialize)]
struct AuthQuery {
    token: String,
}

/// Exchanges the token from the printed URL for a cookie, so the token
/// doesn't have to be threaded through every request (EventSource can't set headers).
async fn auth(State(st): State<Arc<AppState>>, Query(q): Query<AuthQuery>) -> Response {
    if q.token != st.token {
        return (StatusCode::FORBIDDEN, "invalid token").into_response();
    }
    let cookie = format!(
        "{}={}; Path=/; HttpOnly; SameSite=Strict",
        st.cookie, st.token
    );
    ([(header::SET_COOKIE, cookie)], Redirect::to("/")).into_response()
}

/// Keeps other machines on the network, other local users and DNS-rebinding
/// web pages from reading the repository.
async fn require_auth(State(st): State<Arc<AppState>>, req: Request, next: Next) -> Response {
    let authed = req
        .headers()
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|c| c.trim().split_once('='))
        .any(|(k, v)| k == st.cookie && v == st.token);
    if authed {
        next.run(req).await
    } else {
        StatusCode::UNAUTHORIZED.into_response()
    }
}

pub struct AppError(anyhow::Error);

impl<E: Into<anyhow::Error>> From<E> for AppError {
    fn from(e: E) -> Self {
        AppError(e.into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (StatusCode::INTERNAL_SERVER_ERROR, format!("{:#}", self.0)).into_response()
    }
}
