use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use serde::Serialize;
use tokio::process::Command;

const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const NULL_OID: &str = "0000000000000000000000000000000000000000";
/// Untracked files larger than this are not read to count their lines.
const MAX_UNTRACKED_SCAN: u64 = 8 << 20;
/// Some inputs make some git versions' diff algorithms go quadratic; don't hang forever.
const PATCH_TIMEOUT: Duration = Duration::from_secs(60);
/// Fields of a [`Commit`], NUL-separated, one commit per line (subjects never contain newlines).
const LOG_FORMAT: &str = "--format=%H%x00%h%x00%P%x00%an%x00%at%x00%s";

pub struct Options {
    pub revs: Vec<String>,
    pub cached: bool,
    pub paths: Vec<String>,
    pub untracked: bool,
    /// None: the repository's `diff.algorithm` setting, like `git diff`.
    pub algorithm: Option<String>,
    pub context: u32,
}

pub struct Repo {
    pub root: PathBuf,
    pub git_dir: PathBuf,
    /// What the command line asked to compare.
    pub base: Spec,
    pathspecs: Vec<String>,
    /// Resolved up front so line counts in the listing match the diffs, and
    /// so cached diffs are keyed by the algorithm that produced them.
    algorithm: String,
    context: u32,
}

/// The two sides of a diff.
#[derive(Clone)]
pub struct Spec {
    pub title: String,
    /// Revision arguments for `git diff`, e.g. `["HEAD"]` or `["--cached", "HEAD"]`.
    revs: Vec<String>,
    /// The right side is the working tree, and untracked files are part of the diff.
    untracked: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Commit {
    pub id: String,
    pub short: String,
    #[serde(skip)]
    parents: Vec<String>,
    pub author: String,
    /// Author date, seconds since the epoch.
    pub time: i64,
    pub subject: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    /// git status letter (A, M, D, R, C, T, U), or `?` for untracked files.
    pub status: char,
    pub add: u32,
    pub del: u32,
    pub binary: bool,
    /// Too big to scan; line counts are unknown.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub large: bool,
    /// Changes whenever the diff of this file may change. Used as cache key and ETag.
    pub version: String,
    /// Both sides are git objects, so the diff for this version can never change.
    #[serde(skip)]
    pub immutable: bool,
    #[serde(skip)]
    old_oid: String,
    #[serde(skip)]
    new_oid: String,
}

impl Repo {
    pub async fn open(cwd: &Path, opts: Options) -> Result<Repo> {
        let out = run(
            git(cwd).args([
                "rev-parse",
                "--show-toplevel",
                "--absolute-git-dir",
                "--show-prefix",
            ]),
            &[0],
        )
        .await
        .context("not inside a git working tree")?;
        let out = String::from_utf8(out).context("non UTF-8 repository path")?;
        let mut lines = out.lines();
        let root = PathBuf::from(lines.next().context("git rev-parse: missing toplevel")?);
        let git_dir = PathBuf::from(lines.next().context("git rev-parse: missing git dir")?);
        let prefix = lines.next().unwrap_or_default();

        let has_head = head_commit(&root).await?.is_some();
        // An unborn branch has no HEAD yet: compare against the empty tree.
        let (head, head_label) = if has_head {
            ("HEAD", "HEAD")
        } else {
            (EMPTY_TREE, "(empty)")
        };

        let (revs, worktree, title) = match (opts.revs.as_slice(), opts.cached) {
            ([], false) => (
                vec![head.into()],
                true,
                format!("{head_label} ↔ working tree"),
            ),
            ([], true) => (
                vec!["--cached".into(), head.into()],
                false,
                format!("{head_label} ↔ index"),
            ),
            ([r], false) if r.contains("..") => (vec![r.clone()], false, r.clone()),
            ([r], false) => (vec![r.clone()], true, format!("{r} ↔ working tree")),
            ([r], true) => (
                vec!["--cached".into(), r.clone()],
                false,
                format!("{r} ↔ index"),
            ),
            ([a, b], false) => (vec![a.clone(), b.clone()], false, format!("{a} ↔ {b}")),
            _ => bail!("expected at most two revisions, or one with --cached"),
        };

        // We run git from the top level, so make relative pathspecs relative to it.
        let pathspecs = opts
            .paths
            .iter()
            .map(|p| {
                if prefix.is_empty() || p.starts_with(':') {
                    p.clone()
                } else {
                    format!("{prefix}{p}")
                }
            })
            .collect();

        let algorithm = match opts.algorithm {
            Some(a) => a,
            None => configured_algorithm(&root).await,
        };

        Ok(Repo {
            root,
            git_dir,
            base: Spec {
                title,
                revs,
                untracked: worktree && opts.untracked,
            },
            pathspecs,
            algorithm,
            context: opts.context,
        })
    }

    /// All changed files with line counts, sorted by path.
    pub async fn list_files(&self, spec: &Spec) -> Result<Vec<FileEntry>> {
        let tracked = async {
            let out = run(
                self.git()
                    .args([
                        "diff",
                        "--raw",
                        "--numstat",
                        "-z",
                        "-M",
                        "--no-abbrev",
                        "--no-ext-diff",
                        "--no-color",
                    ])
                    .arg(format!("--diff-algorithm={}", self.algorithm))
                    .args(&spec.revs)
                    .arg("--")
                    .args(&self.pathspecs),
                &[0],
            )
            .await?;
            parse_raw_numstat(&out)
        };
        let untracked = async {
            if spec.untracked {
                self.list_untracked().await
            } else {
                Ok(Vec::new())
            }
        };
        let (mut files, untracked) = tokio::try_join!(tracked, untracked)?;
        files.extend(untracked);

        let root = self.root.clone();
        let tag = format!("{}{}", self.algorithm, self.context);
        tokio::task::spawn_blocking(move || {
            files.sort_unstable_by(|a, b| a.path.cmp(&b.path));
            for f in &mut files {
                f.set_version(&root, &tag);
            }
            files
        })
        .await
        .map_err(Into::into)
    }

    async fn list_untracked(&self) -> Result<Vec<FileEntry>> {
        let out = run(
            self.git()
                .args(["ls-files", "--others", "--exclude-standard", "-z", "--"])
                .args(&self.pathspecs),
            &[0],
        )
        .await?;
        let root = self.root.clone();
        tokio::task::spawn_blocking(move || {
            out.split(|&b| b == 0)
                // Nested repositories are listed as "dir/"; they have no diff of their own.
                .filter(|p| !p.is_empty() && !p.ends_with(b"/"))
                .map(|p| {
                    let path = String::from_utf8_lossy(p).into_owned();
                    let (add, binary, large) = scan_untracked(&root.join(&path));
                    FileEntry::new(
                        path,
                        None,
                        '?',
                        NULL_OID.into(),
                        NULL_OID.into(),
                        add,
                        binary,
                        large,
                    )
                })
                .collect()
        })
        .await
        .map_err(Into::into)
    }

    /// Unified diff of a single file, as printed by git.
    pub async fn file_patch(&self, spec: &Spec, f: &FileEntry) -> Result<Vec<u8>> {
        let mut cmd = self.git();
        cmd.args(["diff", "--no-color", "--no-ext-diff"])
            .arg(format!("--diff-algorithm={}", self.algorithm))
            .arg(format!("-U{}", self.context));
        if f.status == '?' {
            cmd.args(["--no-index", "--", "/dev/null"]).arg(&f.path);
            // --no-index exits with 1 when the files differ.
            return with_timeout(run(&mut cmd, &[0, 1])).await;
        }
        // Passing both paths of a rename lets -M pair them up again.
        cmd.arg("-M")
            .args(&spec.revs)
            .arg("--")
            .args(f.old_path.as_ref())
            .arg(&f.path)
            .env("GIT_LITERAL_PATHSPECS", "1");
        with_timeout(run(&mut cmd, &[0])).await
    }

    /// The commit HEAD points to; None on an unborn branch.
    pub async fn head(&self) -> Result<Option<String>> {
        head_commit(&self.root).await
    }

    /// The newest commits from `head` on that touch the pathspecs.
    pub async fn commits(&self, head: &str, limit: usize) -> Result<Vec<Commit>> {
        self.log(&[&format!("-n{limit}"), head], &self.pathspecs)
            .await
    }

    /// One commit against its first parent, or against the empty tree for a root commit.
    pub async fn commit_spec(&self, id: &str) -> Result<Spec> {
        // Only object ids: anything else could be read as an option or a revision range.
        if !(4..=64).contains(&id.len()) || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            bail!("not a commit id: {id}");
        }
        let c = self
            .log(&["--no-walk", id], &[])
            .await?
            .pop()
            .with_context(|| format!("no such commit: {id}"))?;
        let parent = c.parents.first().map_or(EMPTY_TREE, String::as_str);
        Ok(Spec {
            title: format!("{} {}", c.short, c.subject),
            revs: vec![parent.into(), c.id],
            untracked: false,
        })
    }

    async fn log(&self, args: &[&str], pathspecs: &[String]) -> Result<Vec<Commit>> {
        let out = run(
            self.git()
                .args(["log", "--no-color", "--no-show-signature", LOG_FORMAT])
                .args(args)
                .arg("--")
                .args(pathspecs),
            &[0],
        )
        .await?;
        parse_log(&out)
    }

    fn git(&self) -> Command {
        git(&self.root)
    }
}

impl FileEntry {
    #[allow(clippy::too_many_arguments)]
    fn new(
        path: String,
        old_path: Option<String>,
        status: char,
        old_oid: String,
        new_oid: String,
        add: u32,
        binary: bool,
        large: bool,
    ) -> Self {
        FileEntry {
            path,
            old_path,
            status,
            add,
            del: 0,
            binary,
            large,
            version: String::new(),
            immutable: false,
            old_oid,
            new_oid,
        }
    }

    fn set_version(&mut self, root: &Path, tag: &str) {
        let right = if self.status == 'D' {
            self.immutable = true;
            "-".to_string()
        } else if self.status != '?' && self.new_oid != NULL_OID {
            self.immutable = true;
            self.new_oid.clone()
        } else {
            // The working tree side has no object id; its stat data stands in for one.
            stat_token(&root.join(&self.path))
        };
        self.version = format!("{tag}.{}.{right}", self.old_oid);
    }
}

fn git(dir: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.current_dir(dir)
        // We run in the background: never take optional locks or rewrite the
        // index, which would race with the user's git commands and wake our watcher.
        .env("GIT_OPTIONAL_LOCKS", "0")
        .args(["-c", "core.quotePath=false"])
        .stdin(Stdio::null())
        .kill_on_drop(true);
    cmd
}

async fn head_commit(root: &Path) -> Result<Option<String>> {
    let out = run(
        git(root).args(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]),
        &[0, 1],
    )
    .await?;
    let id = String::from_utf8_lossy(&out).trim().to_string();
    Ok((!id.is_empty()).then_some(id))
}

/// The algorithm `git diff` uses here; git's own default is myers.
async fn configured_algorithm(root: &Path) -> String {
    let out = run(git(root).args(["config", "--get", "diff.algorithm"]), &[0]).await;
    match out.ok().and_then(|o| String::from_utf8(o).ok()) {
        Some(a) if !a.trim().is_empty() => a.trim().to_string(),
        _ => "myers".into(),
    }
}

/// Dropping the future kills git (`kill_on_drop`).
async fn with_timeout(fut: impl Future<Output = Result<Vec<u8>>>) -> Result<Vec<u8>> {
    match tokio::time::timeout(PATCH_TIMEOUT, fut).await {
        Ok(res) => res,
        Err(_) => bail!(
            "git diff took more than {}s; try another --algorithm",
            PATCH_TIMEOUT.as_secs()
        ),
    }
}

async fn run(cmd: &mut Command, ok: &[i32]) -> Result<Vec<u8>> {
    let out = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .context("failed to run git")?;
    match out.status.code() {
        Some(code) if ok.contains(&code) => Ok(out.stdout),
        _ => bail!("git: {}", String::from_utf8_lossy(&out.stderr).trim()),
    }
}

/// Parses `git diff --raw --numstat -z`: all raw records come first, then all numstat records.
fn parse_raw_numstat(buf: &[u8]) -> Result<Vec<FileEntry>> {
    let mut toks = buf
        .split(|&b| b == 0)
        .map(String::from_utf8_lossy)
        .peekable();
    let mut files = Vec::new();
    let mut index = HashMap::new();

    // :old_mode new_mode old_oid new_oid status NUL path NUL [new_path NUL]
    while let Some(meta) = toks.next_if(|t| t.starts_with(':')) {
        let mut fields = meta[1..].split(' ').skip(2);
        let (Some(old_oid), Some(new_oid), Some(status)) =
            (fields.next(), fields.next(), fields.next())
        else {
            bail!("unexpected git diff --raw output: {meta}");
        };
        let status = status.chars().next().unwrap_or('M');
        let first = toks
            .next()
            .context("truncated git diff --raw output")?
            .into_owned();
        let (old_path, path) = if matches!(status, 'R' | 'C') {
            let second = toks
                .next()
                .context("truncated git diff --raw output")?
                .into_owned();
            (Some(first), second)
        } else {
            (None, first)
        };
        // Unmerged paths can be reported more than once.
        if index.contains_key(&path) {
            continue;
        }
        index.insert(path.clone(), files.len());
        files.push(FileEntry::new(
            path,
            old_path,
            status,
            old_oid.into(),
            new_oid.into(),
            0,
            false,
            false,
        ));
    }

    // add TAB del TAB path NUL, or for renames: add TAB del TAB NUL old NUL new NUL.
    // Binary files have "-" for both counts.
    while let Some(tok) = toks.next() {
        if tok.is_empty() {
            continue;
        }
        let mut parts = tok.splitn(3, '\t');
        let (add, del, path) = (parts.next(), parts.next(), parts.next().unwrap_or_default());
        let path = if path.is_empty() {
            toks.next();
            toks.next().map(|p| p.into_owned())
        } else {
            Some(path.to_string())
        };
        let Some(&i) = path.as_ref().and_then(|p| index.get(p)) else {
            continue;
        };
        let f = &mut files[i];
        match (
            add.and_then(|a| a.parse().ok()),
            del.and_then(|d| d.parse().ok()),
        ) {
            (Some(a), Some(d)) => (f.add, f.del) = (a, d),
            _ => f.binary = true,
        }
    }
    Ok(files)
}

/// Parses `git log` output in [`LOG_FORMAT`].
fn parse_log(buf: &[u8]) -> Result<Vec<Commit>> {
    String::from_utf8_lossy(buf)
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| {
            let fields: Vec<&str> = line.splitn(6, '\0').collect();
            let &[id, short, parents, author, time, subject] = fields.as_slice() else {
                bail!("unexpected git log output: {line}");
            };
            Ok(Commit {
                id: id.into(),
                short: short.into(),
                parents: parents.split_whitespace().map(Into::into).collect(),
                author: author.into(),
                time: time.parse().unwrap_or_default(),
                subject: subject.into(),
            })
        })
        .collect()
}

/// Line count, binary flag and "too large" flag of an untracked file.
fn scan_untracked(path: &Path) -> (u32, bool, bool) {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return (0, false, false);
    };
    if !meta.is_file() {
        // A symlink diffs as a single line holding its target.
        return (1, false, false);
    }
    if meta.len() > MAX_UNTRACKED_SCAN {
        return (0, false, true);
    }
    let Ok(data) = std::fs::read(path) else {
        return (0, false, false);
    };
    // Same heuristic as git: a NUL byte in the first 8000 bytes means binary.
    if data[..data.len().min(8000)].contains(&0) {
        return (0, true, false);
    }
    let mut lines = data.iter().filter(|&&b| b == b'\n').count();
    if !data.is_empty() && !data.ends_with(b"\n") {
        lines += 1;
    }
    (lines as u32, false, false)
}

fn stat_token(path: &Path) -> String {
    match std::fs::symlink_metadata(path) {
        Ok(m) => {
            let t = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .unwrap_or_default();
            format!("{}.{}-{}", t.as_secs(), t.subsec_nanos(), m.len())
        }
        Err(_) => "missing".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_numstat() {
        let o1 = "ce013625030ba8dba906f756967f9e9ca394464a";
        let o2 = "8352675d67aed6625ece79af41c27fdb4ee2e867";
        let raw = format!(
            ":000000 100644 {NULL_OID} {o2} A\0bin.dat\0\
             :100644 100644 {o1} {o1} R100\0old.txt\0renamed.txt\0\
             :100644 100644 {o1} {NULL_OID} M\0x.txt\0\
             -\t-\tbin.dat\0\
             0\t0\t\0old.txt\0renamed.txt\0\
             2\t1\tx.txt\0"
        );
        let files = parse_raw_numstat(raw.as_bytes()).unwrap();
        assert_eq!(files.len(), 3);
        assert!(files[0].binary && files[0].status == 'A');
        assert_eq!(files[1].old_path.as_deref(), Some("old.txt"));
        assert_eq!(
            (files[1].path.as_str(), files[1].status),
            ("renamed.txt", 'R')
        );
        assert_eq!((files[2].add, files[2].del, files[2].binary), (2, 1, false));
        assert_eq!(files[2].new_oid, NULL_OID);
    }

    #[test]
    fn log() {
        let o1 = "ce013625030ba8dba906f756967f9e9ca394464a";
        let o2 = "8352675d67aed6625ece79af41c27fdb4ee2e867";
        let out = format!(
            "{o2}\08352675\0{o1}\0A U Thor\01700000000\0Merge: a\0b\n\
             {o1}\0ce01362\0\0Someone\01600000000\0Initial\n"
        );
        let commits = parse_log(out.as_bytes()).unwrap();
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].parents, [o1]);
        assert_eq!(commits[0].subject, "Merge: a\0b");
        assert_eq!(
            (commits[0].author.as_str(), commits[0].time),
            ("A U Thor", 1700000000)
        );
        assert!(commits[1].parents.is_empty());
        assert_eq!(commits[1].short, "ce01362");
    }
}
