//! Closing references to a task's GitHub issue in pull request bodies. GitHub closes the
//! issue when a pull request whose body says e.g. `Closes #12` is merged into the default
//! branch.

/// Keywords GitHub accepts before an issue reference to close it on merge.
const CLOSING_KEYWORDS: [&str; 9] = [
    "close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved",
];

/// Whether `body` already has a closing reference to issue `number`, such as
/// `Fixes #12` or `resolves: #12`, in any letter case.
pub fn closes_issue(body: &str, number: i64) -> bool {
    let body = body.to_ascii_lowercase();
    let reference = format!("#{number}");
    let bytes = body.as_bytes();
    let mut search_from = 0;
    while let Some(found) = body[search_from..].find(&reference) {
        let start = search_from + found;
        let end = start + reference.len();
        search_from = end;
        if bytes.get(end).is_some_and(u8::is_ascii_digit) {
            continue;
        }
        if follows_closing_keyword(&body[..start]) {
            return true;
        }
    }
    false
}

/// Whether `before`, the text in front of an issue reference, ends with a closing
/// keyword, an optional colon, and at least one space.
fn follows_closing_keyword(before: &str) -> bool {
    let without_space = before.trim_end_matches([' ', '\t']);
    if without_space.len() == before.len() {
        return false;
    }
    let word = without_space.strip_suffix(':').unwrap_or(without_space);
    CLOSING_KEYWORDS.iter().any(|keyword| {
        word.strip_suffix(keyword).is_some_and(|rest| {
            !rest
                .chars()
                .next_back()
                .is_some_and(|c| c.is_alphanumeric() || c == '_')
        })
    })
}

/// `body` with a closing reference to issue `number` on its own last paragraph.
pub fn with_closing_reference(body: &str, number: i64) -> String {
    let body = body.trim_end();
    if body.is_empty() {
        format!("Closes #{number}")
    } else {
        format!("{body}\n\nCloses #{number}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closing_keywords_before_the_issue_number_are_recognized_in_any_case() {
        for body in [
            "Closes #12",
            "closes #12",
            "Fixes #12.",
            "fixed  #12",
            "RESOLVES: #12",
            "Some text\n\nResolved #12\n",
            "Close #12, close #13",
            "close\t#12",
        ] {
            assert!(closes_issue(body, 12), "{body:?}");
        }
    }

    #[test]
    fn mentions_other_numbers_and_unrelated_words_are_not_closing_references() {
        for body in [
            "",
            "#12",
            "See #12",
            "Closes #123",
            "Closes #1",
            "Closes#12",
            "Prefixes #12",
            "fixes_ #12",
            "Closes #13\nmentions #12",
        ] {
            assert!(!closes_issue(body, 12), "{body:?}");
        }
    }

    #[test]
    fn the_closing_reference_is_appended_as_its_own_paragraph() {
        assert_eq!(with_closing_reference("", 12), "Closes #12");
        assert_eq!(with_closing_reference(" \n", 12), "Closes #12");
        assert_eq!(
            with_closing_reference("Adds login.\n", 12),
            "Adds login.\n\nCloses #12"
        );
        assert!(closes_issue(&with_closing_reference("Adds login.", 12), 12));
    }
}
