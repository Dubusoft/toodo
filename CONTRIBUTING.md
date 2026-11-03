# Contributing to Toodo

Thank you for considering a contribution. Toodo is licensed under the
[GNU Affero General Public License v3.0 only](LICENSE) (`AGPL-3.0-only`).

## Contributor License Agreement

Every outside contribution needs a signed
[Individual Contributor License Agreement](CLA.md) (CLA). The CLA lets the project owner
distribute your contribution under the AGPL and under other licenses, including
commercial ones, while you keep the copyright to your work.

To sign it, add this sentence, with your GitHub username, to the description of your pull
request:

```text
I have read the Toodo Individual Contributor License Agreement (CLA.md, version 1.0) and I agree to its terms. Signed: @<your-github-username>
```

- Add the sentence to every pull request you open; a pull request without it is not
  merged until the sentence is added.
- If you contribute on behalf of your employer, make sure you are allowed to sign the CLA
  for that work (section 5 of the CLA).
- There is no bot or GitHub Action for the CLA; maintainers check the pull request
  description by hand before merging.

## Pull Requests

- Open pull requests against the `dev` branch.
- Keep each pull request to one concern, and write commit messages in the imperative
  mood, in English.
- Follow the language policy and conventions in [`AGENTS.md`](AGENTS.md).
- CI only typechecks. Run the tests, `cargo clippy --all-targets -- -D warnings`, and
  `cargo fmt --check` locally before opening a pull request; see the Commands section of
  [`AGENTS.md`](AGENTS.md).
