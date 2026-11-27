#!/usr/bin/env bash
# Installs the dori-mode skill and the `dori` CLI, then runs `dori setup`.
# Dori lives in dori/ of the public Dubusoft/toodo repo, which is cloned anonymously over https.
# Usage: bash -c "$(curl -fsSL https://raw.githubusercontent.com/Dubusoft/toodo/main/dori/install.sh)"
# Needs: git, bun 1.3+. Optional env: DORI_REPO (owner/name), DORI_BRANCH (default main), DORI_SRC (clone dir),
# SKILLS_DIR (where your agent loads skills).
set -euo pipefail

repo="https://github.com/${DORI_REPO:-Dubusoft/toodo}.git"
branch="${DORI_BRANCH:-main}"
src="${DORI_SRC:-$HOME/.dori/src}"
skills="${SKILLS_DIR:-$HOME/.agents/skills}"

command -v bun >/dev/null || { echo "bun is required: https://bun.sh" >&2; exit 1; }
command -v git >/dev/null || { echo "git is required" >&2; exit 1; }

if [ -d "$src/.git" ]; then
  # An earlier installer had git take its GitHub credentials from gh; the repo is public now.
  git -C "$src" config --unset-all "credential.https://github.com.helper" || true
  git -C "$src" pull --ff-only --quiet
else
  git clone --quiet --depth 1 --branch "$branch" "$repo" "$src"
fi

dori="$src/dori"
[ -d "$dori/skills/dori-mode/scripts" ] || { echo "$dori/skills/dori-mode/scripts is missing: $src is not a checkout of a repo with dori/ (DORI_REPO, DORI_BRANCH)" >&2; exit 1; }

mkdir -p "$skills"
if [ -e "$skills/dori-mode" ] && [ ! -L "$skills/dori-mode" ]; then
  echo "$skills/dori-mode exists and is not a link; leaving it alone" >&2
else
  ln -sfn "$dori/skills/dori-mode" "$skills/dori-mode"
fi

(cd "$dori/skills/dori-mode/scripts" && bun install --silent && bun link --silent)

mkdir -p "$HOME/.dori"
cli="$(command -v dori || echo "$HOME/.bun/bin/dori")"

echo "Installed. Skill: $skills/dori-mode  CLI: $cli"
if [ -t 0 ]; then
  "$cli" setup
else
  echo "Next: run \`dori setup\` in a terminal (bot token, channels, autostart), then tell your agent: Dori mode"
fi
