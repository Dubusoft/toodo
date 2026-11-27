#!/usr/bin/env bash
# Packages a built toodo-server as the release assets the Release and npm workflows upload:
#   OUT_DIR/toodo-server-v<version>-<platform>.tar.gz          the binary, as ./toodo-server,
#                                                              the toodo CLI built beside it,
#                                                              as ./toodo, and the web app,
#                                                              as ./web/
#   OUT_DIR/toodo-server-v<version>-<platform>.tar.gz.sha256   `sha256sum` line for it
# WEB_DIR is the web build (`npm run build` writes dist-web). PLATFORM names the target the
# binaries were built for, as `toodo update` looks for it: linux-x86_64 (the default),
# linux-aarch64, linux-x86_64-musl, linux-aarch64-musl, darwin-x86_64, or darwin-aarch64.
# The version comes from `toodo-server --version`, or from $TOODO_VERSION when it is set
# (the version the binaries were built with, for binaries that cannot run here). Prints the
# tarball path. Runs on Linux and macOS.
# scripts/install-server.sh --release installs the linux-x86_64 asset of a release;
# `toodo update --source github` installs the asset of its platform.
set -euo pipefail

if [ $# -lt 3 ] || [ $# -gt 4 ]; then
  echo "Usage: scripts/package-server.sh BINARY WEB_DIR OUT_DIR [PLATFORM]" >&2
  exit 2
fi
binary=$1
web_dir=$2
out_dir=$3
platform=${4:-linux-x86_64}
case "$platform" in
  linux-x86_64 | linux-aarch64 | linux-x86_64-musl | linux-aarch64-musl | darwin-x86_64 | darwin-aarch64) ;;
  *) echo "error: unknown platform '$platform'" >&2; exit 2 ;;
esac

[ -x "$binary" ] || { echo "error: $binary is not an executable" >&2; exit 1; }
cli=$(dirname "$binary")/toodo
[ -x "$cli" ] || { echo "error: $cli is not an executable; build it with cargo build --release --bin toodo" >&2; exit 1; }
[ -f "$web_dir/index.html" ] || { echo "error: $web_dir has no index.html; run npm run build" >&2; exit 1; }
[ -f "$web_dir/sw.js" ] || { echo "error: $web_dir is not a web build (no sw.js); run npm run build" >&2; exit 1; }
semver='[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?'
if [ -n "${TOODO_VERSION:-}" ]; then
  [[ $TOODO_VERSION =~ ^$semver$ ]] || { echo "error: TOODO_VERSION '$TOODO_VERSION' is not a version" >&2; exit 1; }
  version=$TOODO_VERSION
else
  version_line=$("$binary" --version)
  if ! [[ $version_line =~ ^toodo-server\ ($semver)(\ \(commit\ [0-9a-f]+\))?$ ]]; then
    echo "error: unexpected '$binary --version' output: $version_line" >&2
    exit 1
  fi
  version=${BASH_REMATCH[1]}
fi
name=toodo-server-v$version-$platform

mkdir -p "$out_dir"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
install -m 755 "$binary" "$stage/toodo-server"
install -m 755 "$cli" "$stage/toodo"
mkdir "$stage/web"
cp -R "$web_dir/." "$stage/web/"
chmod -R u=rwX,go=rX "$stage/web"
# GNU tar (Linux) and bsdtar (macOS) spell the owner of the archived files differently.
# (grep reads the whole output: grep -q could stop tar early, failing under pipefail.)
if tar --version 2>/dev/null | grep 'GNU tar' >/dev/null; then
  owner=(--owner=0 --group=0 --numeric-owner)
else
  owner=(--uid 0 --gid 0)
fi
tar -C "$stage" -czf "$out_dir/$name.tar.gz" "${owner[@]}" toodo-server toodo web
if command -v sha256sum >/dev/null 2>&1; then
  sha256=(sha256sum)
else
  sha256=(shasum -a 256)
fi
(cd "$out_dir" && "${sha256[@]}" "$name.tar.gz" >"$name.tar.gz.sha256")
echo "$out_dir/$name.tar.gz"
