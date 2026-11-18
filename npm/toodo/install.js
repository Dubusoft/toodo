'use strict';

// postinstall: fails the install when npm left out the platform package. npm skips an
// optional dependency it cannot download (for example while the registry does not serve its
// tarball yet) with only a warning, which would leave a toodo with no binary to run; failing
// here makes npm report the error and keep the previous install.

const { findPlatformPackage } = require('./lib/platform');

const found = findPlatformPackage();
if (found.error) {
  console.error(`@dubusoft/toodo: ${found.error}`);
  process.exit(1);
}
