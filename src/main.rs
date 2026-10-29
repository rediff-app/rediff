mod assets;
mod git;
mod patch;
mod server;
mod watch;

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;

use anyhow::{Context, Result};
use clap::Parser;

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

/// View git diffs in the browser.
#[derive(Parser)]
#[command(
    version,
    about,
    after_help = "Examples:
  rediff                    working tree vs HEAD, including untracked files
  rediff --cached           index vs HEAD
  rediff main               working tree vs main
  rediff main feature       main vs feature
  rediff HEAD~3..HEAD -- src"
)]
struct Cli {
    /// Revisions to compare, as accepted by `git diff`
    revs: Vec<String>,
    /// Limit the diff to these paths
    #[arg(last = true)]
    paths: Vec<String>,
    /// Compare the index (staged changes) instead of the working tree
    #[arg(long, visible_alias = "staged")]
    cached: bool,
    /// Don't show untracked files
    #[arg(long)]
    no_untracked: bool,
    /// Lines of context around each change
    #[arg(short = 'U', long, default_value_t = 3)]
    unified: u32,
    /// Diff algorithm [default: the repository's diff.algorithm, else myers]
    #[arg(long, value_parser = ["myers", "minimal", "patience", "histogram"])]
    algorithm: Option<String>,
    /// Address to listen on; the default also serves the local network,
    /// 127.0.0.1 keeps it to this machine
    #[arg(long, default_value = "0.0.0.0")]
    host: IpAddr,
    /// Port to listen on; 0 picks a free one
    #[arg(short, long, default_value_t = 0)]
    port: u16,
    /// Don't open a browser
    #[arg(long)]
    no_open: bool,
    /// Don't watch for changes
    #[arg(long)]
    no_watch: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let repo = git::Repo::open(
        &std::env::current_dir()?,
        git::Options {
            revs: cli.revs,
            cached: cli.cached,
            paths: cli.paths,
            untracked: !cli.no_untracked,
            algorithm: cli.algorithm,
            context: cli.unified,
        },
    )
    .await?;

    let listener = tokio::net::TcpListener::bind((cli.host, cli.port))
        .await
        .with_context(|| format!("cannot listen on {}", SocketAddr::new(cli.host, cli.port)))?;
    let port = listener.local_addr()?.port();
    let state = Arc::new(server::AppState::new(
        repo,
        new_token()?,
        port,
        !cli.no_watch,
    ));
    // Fail on bad revisions now rather than serve an error page.
    state.listing().await?;

    if !cli.no_watch {
        let st = state.clone();
        watch::spawn(
            state.repo.root.clone(),
            state.repo.git_dir.clone(),
            move || st.changed(),
        )?;
    }

    let url = |ip| {
        format!(
            "http://{}/auth?token={}",
            SocketAddr::new(ip, port),
            state.token
        )
    };
    eprintln!("rediff: {}", state.repo.base.title);
    let local = if cli.host.is_unspecified() {
        let local = url(IpAddr::V4(Ipv4Addr::LOCALHOST));
        eprintln!("  local:   {local}");
        match lan_ip() {
            Some(ip) => eprintln!("  network: {}", url(ip)),
            None => eprintln!("  network: no LAN address found"),
        }
        local
    } else {
        let only = url(cli.host);
        eprintln!("  {only}");
        only
    };
    if !cli.no_open && can_open_browser() {
        let _ = open::that_detached(&local);
    }

    axum::serve(listener, server::router(state)).await?;
    Ok(())
}

fn new_token() -> Result<String> {
    let mut buf = [0u8; 16];
    getrandom::fill(&mut buf).map_err(|e| anyhow::anyhow!("no randomness: {e}"))?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

/// The address other machines on the network reach us at: the source address
/// of the default route. Connecting a UDP socket sends no packets.
fn lan_ip() -> Option<IpAddr> {
    let sock = std::net::UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    sock.connect((Ipv4Addr::new(8, 8, 8, 8), 80)).ok()?;
    let ip = sock.local_addr().ok()?.ip();
    (!ip.is_loopback() && !ip.is_unspecified()).then_some(ip)
}

/// On a headless Linux box (e.g. over SSH) there is no browser to open.
fn can_open_browser() -> bool {
    !cfg!(target_os = "linux")
        || ["DISPLAY", "WAYLAND_DISPLAY"]
            .iter()
            .any(|v| std::env::var_os(v).is_some())
}
