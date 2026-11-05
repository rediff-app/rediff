//! User settings, kept as YAML in `$HOME/.rediff/config.yml` and changed
//! from the settings dialog of the web UI.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result, anyhow};
use serde::{Deserialize, Serialize};

const HEADER: &str = "\
# rediff settings, also changed from the settings dialog of the web UI.
#   theme:  system, light or dark
#   layout: unified or split
#   wrap:   wrap long lines (true) or scroll them sideways (false)
";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    /// Light or dark, as the operating system prefers.
    #[default]
    System,
    Light,
    Dark,
}

impl Theme {
    pub fn as_str(self) -> &'static str {
        match self {
            Theme::System => "system",
            Theme::Light => "light",
            Theme::Dark => "dark",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Layout {
    #[default]
    Unified,
    Split,
}

/// Missing keys take their defaults; unknown keys are ignored.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub theme: Theme,
    /// How diffs are laid out.
    pub layout: Layout,
    /// Wrap long lines instead of scrolling them sideways.
    pub wrap: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            theme: Theme::default(),
            layout: Layout::default(),
            wrap: true,
        }
    }
}

/// A change from the web UI: absent fields keep their saved value.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Patch {
    theme: Option<Theme>,
    layout: Option<Layout>,
    wrap: Option<bool>,
}

impl Patch {
    fn apply(self, s: &mut Settings) {
        if let Some(theme) = self.theme {
            s.theme = theme;
        }
        if let Some(layout) = self.layout {
            s.layout = layout;
        }
        if let Some(wrap) = self.wrap {
            s.wrap = wrap;
        }
    }
}

pub struct Config {
    /// None without a home directory: settings then last for the session only.
    path: Option<PathBuf>,
    /// Keeps concurrent saves from interleaving their read-modify-write.
    saving: Mutex<()>,
}

impl Config {
    /// The config in `$HOME/.rediff/config.yml`.
    pub fn new() -> Self {
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE")) // Windows
            .filter(|h| !h.is_empty());
        Config::at(home.map(|h| Path::new(&h).join(".rediff").join("config.yml")))
    }

    pub fn at(path: Option<PathBuf>) -> Self {
        Config {
            path,
            saving: Mutex::new(()),
        }
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// The saved settings; the defaults if nothing was saved yet.
    pub fn load(&self) -> Result<Settings> {
        let Some(path) = &self.path else {
            return Ok(Settings::default());
        };
        match fs::read_to_string(path) {
            Ok(text) => parse(&text).with_context(|| format!("invalid {}", path.display())),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(Settings::default()),
            Err(e) => Err(anyhow!(e).context(format!("cannot read {}", path.display()))),
        }
    }

    /// Applies a change to the saved settings and returns the result. A file
    /// that doesn't parse is left alone rather than overwritten.
    pub fn update(&self, patch: Patch) -> Result<Settings> {
        let path = self
            .path
            .as_deref()
            .context("no home directory to save settings in")?;
        let _guard = self.saving.lock().unwrap_or_else(|e| e.into_inner());
        let mut settings = self.load()?;
        patch.apply(&mut settings);
        save(path, &settings).with_context(|| format!("cannot save {}", path.display()))?;
        Ok(settings)
    }
}

fn parse(text: &str) -> Result<Settings> {
    // An empty file, or one with only comments, is an empty document.
    let blank = |l: &str| matches!(l.trim_start().chars().next(), None | Some('#'));
    if text.lines().all(blank) {
        return Ok(Settings::default());
    }
    Ok(yaml_serde::from_str(text)?)
}

fn save(path: &Path, settings: &Settings) -> Result<()> {
    // Write through a symlink (say, into a dotfiles repository) instead of replacing it.
    let target = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    if let Some(dir) = target.parent() {
        fs::create_dir_all(dir)?;
    }
    let text = format!("{HEADER}{}", yaml_serde::to_string(settings)?);
    // Replace the file in one step, so a crash or another rediff never sees half of it.
    let mut tmp = target.clone().into_os_string();
    tmp.push(format!(".{}.tmp", std::process::id()));
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, text)?;
    fs::rename(&tmp, &target).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_config(name: &str) -> Config {
        let dir = std::env::temp_dir().join(format!("rediff-config-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        Config::at(Some(dir.join(".rediff").join("config.yml")))
    }

    #[test]
    fn missing_and_empty_files_mean_defaults() {
        let config = temp_config("missing");
        assert_eq!(config.load().unwrap(), Settings::default());
        assert_eq!(parse("").unwrap(), Settings::default());
        assert_eq!(parse("# nothing yet\n\n").unwrap(), Settings::default());
        assert_eq!(Config::at(None).load().unwrap(), Settings::default());
    }

    #[test]
    fn missing_keys_take_defaults_and_unknown_keys_are_ignored() {
        let s = parse("theme: dark\nfuture: 1\n").unwrap();
        assert_eq!(
            s,
            Settings {
                theme: Theme::Dark,
                ..Settings::default()
            }
        );
    }

    #[test]
    fn invalid_values_are_errors() {
        let err = parse("theme: blue\n").unwrap_err();
        assert!(format!("{err:#}").contains("blue"), "{err:#}");
        assert!(parse("wrap: maybe\n").is_err());
    }

    #[test]
    fn update_saves_yaml_and_keeps_other_settings() {
        let config = temp_config("update");
        let patch = |p: &str| serde_json::from_str::<Patch>(p).unwrap();
        config.update(patch(r#"{"layout":"split"}"#)).unwrap();
        let s = config.update(patch(r#"{"theme":"light"}"#)).unwrap();
        assert_eq!(
            s,
            Settings {
                theme: Theme::Light,
                layout: Layout::Split,
                wrap: true
            }
        );
        let text = fs::read_to_string(config.path().unwrap()).unwrap();
        assert!(text.starts_with("# rediff settings"), "{text}");
        assert!(text.contains("theme: light\n"), "{text}");
        assert!(text.contains("layout: split\n"), "{text}");
        assert_eq!(config.load().unwrap(), s);
        let _ = fs::remove_dir_all(config.path().unwrap().parent().unwrap().parent().unwrap());
    }

    #[test]
    fn update_leaves_an_invalid_file_alone() {
        let config = temp_config("invalid");
        let path = config.path().unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "theme: [\n").unwrap();
        assert!(config.update(Patch::default()).is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "theme: [\n");
        let _ = fs::remove_dir_all(path.parent().unwrap().parent().unwrap());
    }

    #[test]
    fn patches_reject_unknown_fields_and_values() {
        assert!(serde_json::from_str::<Patch>(r#"{"theme":"blue"}"#).is_err());
        assert!(serde_json::from_str::<Patch>(r#"{"colour":"dark"}"#).is_err());
    }
}
