'use strict';

// Finds the platform package @dubusoft/toodo-<target> that holds the toodo and
// toodo-server binaries for this machine. Shared by the launcher (bin/toodo.js) and the
// install check (install.js).

const fs = require('fs');
const path = require('path');

const SUPPORTED = 'macOS x64 and arm64, and Linux x64 and arm64 (glibc or musl)';
const REINSTALL = 'npm install -g @dubusoft/toodo --include=optional';

// Whether this Linux runs on musl (Alpine and others) rather than glibc.
function isMusl() {
  try {
    if (process.report) {
      process.report.excludeNetwork = true;
      const header = process.report.getReport().header;
      if (header) return !header.glibcVersionRuntime;
    }
  } catch {
    // Fall through to the next check.
  }
  try {
    return fs.readFileSync('/usr/bin/ldd', 'utf8').includes('musl');
  } catch {
    return false;
  }
}

function platformSuffix() {
  if (process.arch !== 'x64' && process.arch !== 'arm64') return null;
  if (process.platform === 'darwin') return `darwin-${process.arch}`;
  if (process.platform === 'linux') return `linux-${process.arch}${isMusl() ? '-musl' : ''}`;
  return null;
}

// The platform package directory as { dir }, or { error } with the message to print.
function findPlatformPackage() {
  const suffix = platformSuffix();
  if (!suffix) {
    return {
      error:
        `${process.platform}/${process.arch} is not supported; only ${SUPPORTED} are. ` +
        'Build toodo-server from source instead, following docs/server.md in https://github.com/Dubusoft/toodo.',
    };
  }
  const pkg = `@dubusoft/toodo-${suffix}`;
  let dir;
  try {
    dir = path.dirname(require.resolve(`${pkg}/package.json`));
  } catch {
    return {
      error:
        `the platform package ${pkg} is not installed. ` +
        `Reinstall with optional dependencies enabled: ${REINSTALL} ` +
        '(--no-optional or --omit=optional skips it). If it is still missing, npm could not download ' +
        `${pkg} for this version (it may not be on the registry yet); retry in a few minutes, or install ` +
        'the newest release with: npm install -g @dubusoft/toodo@latest --include=optional',
    };
  }
  for (const name of ['toodo', 'toodo-server']) {
    const file = path.join(dir, 'bin', name);
    if (!fs.existsSync(file)) {
      return { error: `${file} is missing from ${pkg}. Reinstall with: ${REINSTALL}` };
    }
  }
  return { dir };
}

module.exports = { findPlatformPackage, REINSTALL };
