#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SUPPORTED = 'macOS x64 and arm64, and Linux x64 and arm64 (glibc or musl)';

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

const suffix = platformSuffix();
if (!suffix) {
  console.error(
    `toodo: ${process.platform}/${process.arch} is not supported; only ${SUPPORTED} are. ` +
      'Build toodo-server from source instead, following docs/server.md in https://github.com/Dubusoft/toodo.'
  );
  process.exit(1);
}

const pkg = `@dubusoft/toodo-${suffix}`;
let pkgDir;
try {
  pkgDir = path.dirname(require.resolve(`${pkg}/package.json`));
} catch {
  console.error(
    `toodo: the platform package ${pkg} is not installed. ` +
      'Reinstall with optional dependencies enabled: npm install -g @dubusoft/toodo --include=optional ' +
      '(--no-optional or --omit=optional skips it). If it is still missing, this version was published ' +
      `without ${pkg}; install the newest one with: npm install -g @dubusoft/toodo@latest --include=optional`
  );
  process.exit(1);
}

const bin = path.join(pkgDir, 'bin', 'toodo');
const result = spawnSync(bin, process.argv.slice(2), { stdio: 'inherit' });

if (result.error) {
  console.error(
    `toodo: could not run ${bin}: ${result.error.message}. ` +
      'Reinstall with: npm install -g @dubusoft/toodo --include=optional'
  );
  process.exit(1);
}
if (result.signal) {
  process.kill(process.pid, result.signal);
} else {
  process.exit(result.status === null ? 1 : result.status);
}
