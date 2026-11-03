#!/usr/bin/env node
// Stages the npm packages for the toodo CLI.
// Usage: node scripts/package-npm.mjs --version <semver> --web <web dir> --out <out dir>
//          --binaries <target>=<dir> [--binaries <target>=<dir> ...]
import {
  accessSync,
  chmodSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE =
  'Usage: node scripts/package-npm.mjs --version <semver> --web <web dir> --out <out dir> ' +
  '--binaries <linux-x64|linux-arm64>=<dir> [--binaries <target>=<dir> ...]';
const TARGETS = { 'linux-x64': 'x64', 'linux-arm64': 'arm64' };
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
const HOMEPAGE = 'https://github.com/dev-bokdong/toodo';
const here = path.dirname(fileURLToPath(import.meta.url));
const templateDir = path.resolve(here, '..', 'npm', 'toodo');

function fail(message) {
  console.error(`package-npm: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { binaries: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!['--version', '--web', '--out', '--binaries'].includes(flag)) {
      fail(`unknown argument "${flag}". ${USAGE}`);
    }
    if (value === undefined || value.startsWith('--')) fail(`${flag} needs a value. ${USAGE}`);
    if (flag === '--binaries') args.binaries.push(value);
    else args[flag.slice(2)] = value;
  }
  for (const required of ['version', 'web', 'out']) {
    if (!args[required]) fail(`missing --${required}. ${USAGE}`);
  }
  if (args.binaries.length === 0) fail(`missing --binaries. ${USAGE}`);
  return args;
}

function isDir(p) {
  return existsSync(p) && statSync(p).isDirectory();
}

const args = parseArgs(process.argv.slice(2));

if (!SEMVER.test(args.version)) {
  fail(`--version "${args.version}" is not a semver version; pass one like 1.3.2 or 1.3.2-dev.7.`);
}

const web = path.resolve(args.web);
if (!existsSync(path.join(web, 'index.html'))) {
  fail(`${web}/index.html not found; run "npm run build" and pass --web dist-web.`);
}

const binaries = new Map();
for (const spec of args.binaries) {
  const eq = spec.indexOf('=');
  const target = eq < 0 ? spec : spec.slice(0, eq);
  const dir = eq < 0 ? '' : spec.slice(eq + 1);
  if (!(target in TARGETS)) {
    fail(`unknown target "${target}"; use --binaries linux-x64=<dir> or --binaries linux-arm64=<dir>.`);
  }
  if (!dir) fail(`--binaries ${target} has no directory; pass --binaries ${target}=<dir>.`);
  if (binaries.has(target)) fail(`target ${target} passed twice; pass --binaries ${target}=<dir> once.`);
  const abs = path.resolve(dir);
  for (const name of ['toodo', 'toodo-server']) {
    const file = path.join(abs, name);
    if (!existsSync(file)) fail(`${file} not found; build ${name} for ${target} and put it in ${abs}.`);
    try {
      accessSync(file, constants.X_OK);
    } catch {
      fail(`${file} is not executable; run "chmod +x ${file}".`);
    }
  }
  binaries.set(target, abs);
}

const out = path.resolve(args.out);
mkdirSync(out, { recursive: true });
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const dirs = [];

for (const [target, binDir] of binaries) {
  const arch = TARGETS[target];
  const dir = path.join(out, `toodo-${target}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, 'bin'), { recursive: true });
  for (const name of ['toodo', 'toodo-server']) {
    const dest = path.join(dir, 'bin', name);
    cpSync(path.join(binDir, name), dest);
    chmodSync(dest, 0o755);
  }
  cpSync(web, path.join(dir, 'web'), { recursive: true });
  writeFileSync(
    path.join(dir, 'README.md'),
    `# @dubusoft/toodo-linux-${arch}\n\nLinux ${arch} binaries for [@dubusoft/toodo](${HOMEPAGE}). Install \`@dubusoft/toodo\` instead of this package.\n`,
  );
  writeJson(path.join(dir, 'package.json'), {
    name: `@dubusoft/toodo-linux-${arch}`,
    version: args.version,
    description: `Toodo server and CLI binaries for Linux ${arch}`,
    license: 'AGPL-3.0-only',
    homepage: HOMEPAGE,
    repository: { type: 'git', url: 'git+https://github.com/dev-bokdong/toodo.git' },
    os: ['linux'],
    cpu: [arch],
    libc: ['glibc'],
    files: ['bin', 'web'],
  });
  dirs.push(dir);
}

const mainDir = path.join(out, 'toodo');
rmSync(mainDir, { recursive: true, force: true });
mkdirSync(path.join(mainDir, 'bin'), { recursive: true });
if (!isDir(templateDir)) fail(`${templateDir} not found; run the script from a full checkout of the repository.`);
const launcher = path.join(mainDir, 'bin', 'toodo.js');
cpSync(path.join(templateDir, 'bin', 'toodo.js'), launcher);
chmodSync(launcher, 0o755);
cpSync(path.join(templateDir, 'README.md'), path.join(mainDir, 'README.md'));
writeJson(path.join(mainDir, 'package.json'), {
  name: '@dubusoft/toodo',
  version: args.version,
  description: 'Toodo command line: task planning that turns a plan into reviewed code',
  license: 'AGPL-3.0-only',
  homepage: HOMEPAGE,
  repository: { type: 'git', url: 'git+https://github.com/dev-bokdong/toodo.git' },
  bin: { toodo: 'bin/toodo.js' },
  files: ['bin'],
  engines: { node: '>=18' },
  optionalDependencies: Object.fromEntries(
    [...binaries.keys()].map((t) => [`@dubusoft/toodo-linux-${TARGETS[t]}`, args.version]),
  ),
});
dirs.push(mainDir);

process.stdout.write(`${dirs.join('\n')}\n`);
