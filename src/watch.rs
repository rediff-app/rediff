use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use anyhow::Result;
use notify::event::{AccessKind, AccessMode, ModifyKind};
use notify::{Event, EventKind, RecursiveMode, Watcher};

/// A burst of events ends after this much silence...
const QUIET: Duration = Duration::from_millis(100);
/// ...or after this long, so continuous writes still refresh the page.
const MAX_DELAY: Duration = Duration::from_millis(500);

/// Calls `on_change` once per burst of changes to the working tree, the index or refs.
///
/// On Linux every non-ignored directory gets its own inotify watch: a recursive
/// watch would also cover `node_modules` or `target` and can exhaust the
/// per-user watch limit. Other platforms have cheap native recursive watches.
pub fn spawn(root: PathBuf, git_dir: PathBuf, on_change: impl Fn() + Send + 'static) -> Result<()> {
    let (tx, rx) = mpsc::channel();
    let mut watcher = notify::recommended_watcher(tx)?;
    watcher.watch(&git_dir, RecursiveMode::NonRecursive)?;
    let refs = git_dir.join("refs");
    if refs.is_dir() {
        watcher.watch(&refs, RecursiveMode::Recursive)?;
    }

    std::thread::Builder::new()
        .name("rediff-watch".into())
        .spawn(move || {
            // Walking a big tree takes a while; do it here rather than delay startup.
            if cfg!(target_os = "linux") {
                watch_tree(&mut watcher, &root, &git_dir);
            } else if let Err(e) = watcher.watch(&root, RecursiveMode::Recursive) {
                eprintln!("rediff: cannot watch {}: {e}", root.display());
            }

            for res in &rx {
                if !handle(&mut watcher, &root, &git_dir, res) {
                    continue;
                }
                let deadline = Instant::now() + MAX_DELAY;
                while let Some(left) = deadline.checked_duration_since(Instant::now()) {
                    match rx.recv_timeout(QUIET.min(left)) {
                        Ok(res) => {
                            handle(&mut watcher, &root, &git_dir, res);
                        }
                        Err(_) => break,
                    }
                }
                on_change();
            }
        })?;
    Ok(())
}

/// Whether the event can change the diff. Starts watching newly created directories.
fn handle(
    watcher: &mut impl Watcher,
    root: &Path,
    git_dir: &Path,
    res: notify::Result<Event>,
) -> bool {
    // Errors include queue overflows, after which anything may have changed.
    let Ok(ev) = res else { return true };
    if matches!(ev.kind, EventKind::Access(a) if a != AccessKind::Close(AccessMode::Write)) {
        return false;
    }
    let new_dir = matches!(
        ev.kind,
        EventKind::Create(_) | EventKind::Modify(ModifyKind::Name(_))
    );
    let mut relevant = false;
    for path in &ev.paths {
        if let Ok(rel) = path.strip_prefix(git_dir) {
            relevant |= is_git_state(rel);
            continue;
        }
        relevant = true;
        if cfg!(target_os = "linux") && new_dir && path.is_dir() && !is_ignored(root, path) {
            watch_tree(watcher, path, git_dir);
        }
    }
    relevant
}

/// Files in the git dir whose changes affect what we show.
fn is_git_state(rel: &Path) -> bool {
    if rel.extension().is_some_and(|e| e == "lock") {
        return false;
    }
    rel.starts_with("refs")
        || ["index", "HEAD", "packed-refs"]
            .iter()
            .any(|f| rel == Path::new(f))
}

fn is_ignored(root: &Path, path: &Path) -> bool {
    std::process::Command::new("git")
        .args(["check-ignore", "-q", "--"])
        .arg(path)
        .current_dir(root)
        .stdin(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

fn watch_tree(watcher: &mut impl Watcher, dir: &Path, git_dir: &Path) {
    let walk = ignore::WalkBuilder::new(dir)
        .hidden(false)
        .filter_entry(|e| e.file_name() != ".git")
        .build();
    let mut failed = 0;
    for entry in walk.flatten() {
        if entry.file_type().is_some_and(|t| t.is_dir())
            && !entry.path().starts_with(git_dir)
            && watcher
                .watch(entry.path(), RecursiveMode::NonRecursive)
                .is_err()
        {
            failed += 1;
        }
    }
    if failed > 0 {
        eprintln!(
            "rediff: could not watch {failed} directories (inotify limit? see /proc/sys/fs/inotify/max_user_watches); \
             changes there won't refresh the page"
        );
    }
}
