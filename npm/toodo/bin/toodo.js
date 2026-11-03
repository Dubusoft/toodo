#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const SUPPORTED = 'Linux x64 and Linux arm64';

if (process.platform !== 'linux' || (process.arch !== 'x64' && process.arch !== 'arm64')) {
  console.error(
    `toodo: ${process.platform}/${process.arch} is not supported; only ${SUPPORTED} are. ` +
      'Build toodo-server from source instead, following docs/server.md in https://github.com/dev-bokdong/toodo.'
  );
  process.exit(1);
}

const pkg = `@dubusoft/toodo-linux-${process.arch}`;
let pkgDir;
try {
  pkgDir = path.dirname(require.resolve(`${pkg}/package.json`));
} catch {
  console.error(
    `toodo: the platform package ${pkg} is not installed. ` +
      'Reinstall with optional dependencies enabled: npm install -g @dubusoft/toodo --include=optional ' +
      '(--no-optional or --omit=optional skips it).'
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
