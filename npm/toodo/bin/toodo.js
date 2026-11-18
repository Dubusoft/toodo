#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const { findPlatformPackage, REINSTALL } = require('../lib/platform');

const found = findPlatformPackage();
if (found.error) {
  console.error(`toodo: ${found.error}`);
  process.exit(1);
}

const bin = path.join(found.dir, 'bin', 'toodo');
const result = spawnSync(bin, process.argv.slice(2), { stdio: 'inherit' });

if (result.error) {
  console.error(`toodo: could not run ${bin}: ${result.error.message}. Reinstall with: ${REINSTALL}`);
  process.exit(1);
}
if (result.signal) {
  process.kill(process.pid, result.signal);
} else {
  process.exit(result.status === null ? 1 : result.status);
}
