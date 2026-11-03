//! Slugs used in worktree directory names and branch names.
//!
//! A slug contains only lowercase ASCII letters, digits, and single inner hyphens, so it
//! is valid as a Windows directory name, a POSIX directory name, and a git ref component.
//! Other characters (including non-ASCII letters) act as word separators.

const MAX_SLUG_LEN: usize = 48;

const WINDOWS_RESERVED_NAMES: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Converts `input` to a slug. Returns `fallback` when nothing usable remains, and appends
/// `-<fallback>` to Windows reserved device names such as `con`.
pub fn slugify(input: &str, fallback: &str) -> String {
    let mut slug = String::with_capacity(input.len().min(MAX_SLUG_LEN));
    let mut pending_hyphen = false;
    for c in input.chars() {
        if c.is_ascii_alphanumeric() {
            if pending_hyphen && !slug.is_empty() {
                slug.push('-');
            }
            pending_hyphen = false;
            slug.push(c.to_ascii_lowercase());
        } else {
            pending_hyphen = true;
        }
    }
    if slug.len() > MAX_SLUG_LEN {
        slug.truncate(MAX_SLUG_LEN);
        slug.truncate(slug.trim_end_matches('-').len());
    }
    if slug.is_empty() {
        return fallback.to_owned();
    }
    if WINDOWS_RESERVED_NAMES.contains(&slug.as_str()) {
        return format!("{slug}-{fallback}");
    }
    slug
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_are_lowercased_and_joined_with_single_hyphens() {
        assert_eq!(slugify("Add  Login -- Page!", "task"), "add-login-page");
        assert_eq!(
            slugify("  --leading and trailing--  ", "task"),
            "leading-and-trailing"
        );
    }

    #[test]
    fn windows_invalid_characters_and_trailing_dots_are_removed() {
        assert_eq!(
            slugify(r#"a<b>c:d"e/f\g|h?i*j"#, "task"),
            "a-b-c-d-e-f-g-h-i-j"
        );
        assert_eq!(slugify("release. . .", "task"), "release");
    }

    #[test]
    fn git_ref_hazards_are_removed() {
        assert_eq!(slugify("..", "task"), "task");
        assert_eq!(slugify("config.lock", "task"), "config-lock");
        assert_eq!(slugify("main@{1}", "task"), "main-1");
        assert_eq!(slugify("a..b~c^d:e", "task"), "a-b-c-d-e");
    }

    #[test]
    fn empty_and_non_ascii_inputs_fall_back() {
        assert_eq!(slugify("", "task"), "task");
        assert_eq!(slugify("로그인 페이지", "task"), "task");
        assert_eq!(slugify("로그인 API 추가", "task"), "api");
    }

    #[test]
    fn windows_reserved_names_get_a_suffix() {
        assert_eq!(slugify("CON", "workspace"), "con-workspace");
        assert_eq!(slugify("lpt9.", "task"), "lpt9-task");
        assert_eq!(slugify("console", "task"), "console");
    }

    #[test]
    fn long_inputs_are_truncated_without_a_trailing_hyphen() {
        let slug = slugify(&format!("{} tail", "a".repeat(47)), "task");
        assert_eq!(slug, "a".repeat(47));
        assert_eq!(slugify(&"b".repeat(100), "task").len(), MAX_SLUG_LEN);
    }
}
