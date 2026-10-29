//! Turns `git diff` output for one file into compact rows for the frontend.

use serde::Serialize;
use serde::ser::{SerializeSeq, Serializer};
use similar::{Algorithm, DiffOp, capture_diff_slices};

pub const CTX: u8 = 0;
pub const ADD: u8 = 1;
pub const DEL: u8 = 2;
pub const HUNK: u8 = 3;

/// Longer lines are not diffed word by word.
const MAX_INLINE_LEN: usize = 1000;

pub struct Row {
    pub kind: u8,
    /// Line numbers, 0 when the line doesn't exist on that side. For hunk rows: the start lines.
    pub old: u32,
    pub new: u32,
    pub text: String,
    /// Changed ranges within the line, as flat [start, end, ...] UTF-16 offsets.
    pub inline: Vec<u32>,
}

/// Serialized as `[kind, old, new, text]` or `[kind, old, new, text, inline]`,
/// which is several times smaller than objects with field names.
impl Serialize for Row {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let n = if self.inline.is_empty() { 4 } else { 5 };
        let mut seq = s.serialize_seq(Some(n))?;
        seq.serialize_element(&self.kind)?;
        seq.serialize_element(&self.old)?;
        seq.serialize_element(&self.new)?;
        seq.serialize_element(&self.text)?;
        if n == 5 {
            seq.serialize_element(&self.inline)?;
        }
        seq.end()
    }
}

#[derive(Serialize)]
pub struct FileDiff {
    pub binary: bool,
    pub rows: Vec<Row>,
}

pub fn parse(patch: &[u8]) -> FileDiff {
    let mut rows = Vec::new();
    let mut binary = false;
    let mut in_hunk = false;
    let (mut old, mut new) = (0u32, 0u32);

    for line in patch.split(|&b| b == b'\n') {
        if line.starts_with(b"@@") {
            (old, new) = parse_hunk_header(line).unwrap_or_default();
            in_hunk = true;
            rows.push(Row {
                kind: HUNK,
                old,
                new,
                text: text(line),
                inline: Vec::new(),
            });
            continue;
        }
        if !in_hunk {
            binary |= line.starts_with(b"Binary files ") || line == b"GIT binary patch";
            continue;
        }
        let (kind, o, n) = match line.first() {
            Some(b' ') => {
                (old, new) = (old + 1, new + 1);
                (CTX, old - 1, new - 1)
            }
            Some(b'+') => {
                new += 1;
                (ADD, 0, new - 1)
            }
            Some(b'-') => {
                old += 1;
                (DEL, old - 1, 0)
            }
            // "\ No newline at end of file"
            Some(b'\\') => continue,
            // Header of another section (a type change diffs as delete + add), or the end.
            _ => {
                in_hunk = false;
                continue;
            }
        };
        rows.push(Row {
            kind,
            old: o,
            new: n,
            text: text(&line[1..]),
            inline: Vec::new(),
        });
    }
    mark_inline(&mut rows);
    FileDiff { binary, rows }
}

fn text(line: &[u8]) -> String {
    String::from_utf8_lossy(line.strip_suffix(b"\r").unwrap_or(line)).into_owned()
}

/// "@@ -12,5 +12,6 @@ heading" -> (12, 12)
fn parse_hunk_header(line: &[u8]) -> Option<(u32, u32)> {
    let (old, rest) = leading_number(line.strip_prefix(b"@@ -")?)?;
    let plus = rest.iter().position(|&b| b == b'+')?;
    let (new, _) = leading_number(&rest[plus + 1..])?;
    Some((old, new))
}

fn leading_number(s: &[u8]) -> Option<(u32, &[u8])> {
    let end = s
        .iter()
        .position(|b| !b.is_ascii_digit())
        .unwrap_or(s.len());
    Some((
        std::str::from_utf8(&s[..end]).ok()?.parse().ok()?,
        &s[end..],
    ))
}

/// Pairs each run of deleted lines with the added lines right after it and
/// marks the words that changed between them.
fn mark_inline(rows: &mut [Row]) {
    let mut i = 0;
    while i < rows.len() {
        if rows[i].kind != DEL {
            i += 1;
            continue;
        }
        let del_start = i;
        while i < rows.len() && rows[i].kind == DEL {
            i += 1;
        }
        let add_start = i;
        while i < rows.len() && rows[i].kind == ADD {
            i += 1;
        }
        for k in 0..(add_start - del_start).min(i - add_start) {
            let (a, b) = (del_start + k, add_start + k);
            if let Some((ra, rb)) = inline_ranges(&rows[a].text, &rows[b].text) {
                rows[a].inline = ra;
                rows[b].inline = rb;
            }
        }
    }
}

fn inline_ranges(a: &str, b: &str) -> Option<(Vec<u32>, Vec<u32>)> {
    if a.len() > MAX_INLINE_LEN || b.len() > MAX_INLINE_LEN || a == b {
        return None;
    }
    let (ta, tb) = (tokenize(a), tokenize(b));
    let (oa, ob) = (utf16_offsets(&ta), utf16_offsets(&tb));
    let (mut ra, mut rb) = (Vec::new(), Vec::new());
    for op in capture_diff_slices(Algorithm::Myers, &ta, &tb) {
        match op {
            DiffOp::Equal { .. } => {}
            DiffOp::Delete {
                old_index, old_len, ..
            } => {
                push_range(&mut ra, oa[old_index], oa[old_index + old_len]);
            }
            DiffOp::Insert {
                new_index, new_len, ..
            } => {
                push_range(&mut rb, ob[new_index], ob[new_index + new_len]);
            }
            DiffOp::Replace {
                old_index,
                old_len,
                new_index,
                new_len,
            } => {
                push_range(&mut ra, oa[old_index], oa[old_index + old_len]);
                push_range(&mut rb, ob[new_index], ob[new_index + new_len]);
            }
        }
    }
    // When both lines changed almost entirely, word marks are just noise.
    let mostly = |r: &[u32], total: u32| covered(r) * 10 >= total * 6;
    if mostly(&ra, oa[ta.len()]) && mostly(&rb, ob[tb.len()]) {
        return None;
    }
    Some((ra, rb))
}

/// Splits into runs of word characters, runs of whitespace, and single other characters.
fn tokenize(s: &str) -> Vec<&str> {
    fn class(c: char) -> u8 {
        if c.is_alphanumeric() || c == '_' {
            0
        } else if c.is_whitespace() {
            1
        } else {
            2
        }
    }
    let mut out = Vec::new();
    let mut it = s.char_indices().peekable();
    while let Some((start, c)) = it.next() {
        let cls = class(c);
        let mut end = start + c.len_utf8();
        if cls != 2 {
            while let Some((i, c)) = it.next_if(|&(_, c)| class(c) == cls) {
                end = i + c.len_utf8();
            }
        }
        out.push(&s[start..end]);
    }
    out
}

fn utf16_offsets(tokens: &[&str]) -> Vec<u32> {
    let mut out = Vec::with_capacity(tokens.len() + 1);
    let mut pos = 0;
    out.push(0);
    for t in tokens {
        pos += t.encode_utf16().count() as u32;
        out.push(pos);
    }
    out
}

fn push_range(ranges: &mut Vec<u32>, start: u32, end: u32) {
    match ranges.last_mut() {
        Some(last) if *last == start => *last = end,
        _ => ranges.extend([start, end]),
    }
}

fn covered(ranges: &[u32]) -> u32 {
    ranges.chunks(2).map(|r| r[1] - r[0]).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hunks_and_line_numbers() {
        let patch = b"diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n\
            @@ -1,3 +1,3 @@ fn main()\n a\n-let x = 1;\n+let x = 2;\n c\n\\ No newline at end of file\n";
        let d = parse(patch);
        assert!(!d.binary);
        let kinds: Vec<_> = d.rows.iter().map(|r| (r.kind, r.old, r.new)).collect();
        assert_eq!(
            kinds,
            [
                (HUNK, 1, 1),
                (CTX, 1, 1),
                (DEL, 2, 0),
                (ADD, 0, 2),
                (CTX, 3, 3)
            ]
        );
        assert_eq!(d.rows[2].text, "let x = 1;");
        // Only the number changed.
        assert_eq!(d.rows[2].inline, [8, 9]);
        assert_eq!(d.rows[3].inline, [8, 9]);
    }

    #[test]
    fn binary() {
        let d = parse(
            b"diff --git a/b b/b\nnew file mode 100644\nBinary files /dev/null and b/b differ\n",
        );
        assert!(d.binary && d.rows.is_empty());
    }

    #[test]
    fn inline_offsets_are_utf16() {
        let (a, b) = inline_ranges("名前 = 1", "名前 = 2").unwrap();
        assert_eq!((a, b), (vec![5, 6], vec![5, 6]));
        // Completely different lines get no word marks.
        assert!(inline_ranges("foo", "bar").is_none());
    }
}
