// Command-line parsing for scripts/package-npm.mjs, kept apart from its staging work so
// tests can import it.

export const USAGE =
  'Usage: node scripts/package-npm.mjs --version <semver> --web <web dir> --out <out dir> ' +
  '--binaries <target>=<dir> [--binaries <target>=<dir> ...], where <target> is one of ' +
  'linux-x64, linux-arm64, linux-x64-musl, linux-arm64-musl, darwin-x64, darwin-arm64';
export const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

// Reads `--flag value` pairs; throws an Error with the message to print.
export function parseArgs(argv) {
  const args = { binaries: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!['--version', '--web', '--out', '--binaries'].includes(flag)) {
      throw new Error(`unknown argument "${flag}". ${USAGE}`);
    }
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value. ${USAGE}`);
    if (flag === '--binaries') args.binaries.push(value);
    else args[flag.slice(2)] = value;
  }
  for (const required of ['version', 'web', 'out']) {
    if (!args[required]) throw new Error(`missing --${required}. ${USAGE}`);
  }
  if (args.binaries.length === 0) throw new Error(`missing --binaries. ${USAGE}`);
  return args;
}
