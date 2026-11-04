#!/usr/bin/env node
// Smoke-tests the npm packages staged by scripts/package-npm.mjs before they are published:
// serves them from a throwaway local registry, installs @dubusoft/toodo globally into a
// temporary prefix the way users do, runs `toodo init`, and checks that the server answers.
// Everything (HOME, npm cache, data directory) lives in one temporary directory that is
// removed afterwards; the server listens on a free loopback port.
// Usage: node scripts/smoke-npm.mjs <staged dir> [--keep]
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const USAGE = 'Usage: node scripts/smoke-npm.mjs <dir passed to package-npm.mjs as --out> [--keep]';
const SERVER_PORTS = new Set([47616, 47617]);

class SmokeError extends Error {}

function fail(message) {
  throw new SmokeError(message);
}

function step(message) {
  console.log(`smoke-npm: ${message}`);
}

function parseArgs(argv) {
  const args = { dir: null, keep: false };
  for (const arg of argv) {
    if (arg === '--keep') args.keep = true;
    else if (arg.startsWith('--') || args.dir !== null) {
      console.error(`smoke-npm: unexpected argument "${arg}". ${USAGE}`);
      process.exit(2);
    } else args.dir = arg;
  }
  if (args.dir === null) {
    console.error(`smoke-npm: missing the staged directory. ${USAGE}`);
    process.exit(2);
  }
  return args;
}

function run(command, args, options) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) fail(`cannot run ${command}: ${result.error.message}; check that it is on PATH.`);
  return result;
}

// Runs a command without blocking the event loop, so the in-process registry keeps answering
// it; its output goes straight to the terminal. Resolves to the exit code.
function runInherited(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.once('error', (error) => reject(new SmokeError(`cannot run ${command}: ${error.message}; check that it is on PATH.`)));
    child.once('close', (code) => resolve(code));
  });
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Packs a staged package directory and returns the registry entry for its version.
function pack(dir, tarballs, env) {
  const result = run('npm', ['pack', dir, '--pack-destination', tarballs, '--json'], { env });
  if (result.status !== 0) fail(`npm pack ${dir} failed:\n${result.stderr}`);
  // npm 10 and older print an array of packed packages, npm 11 and later an object keyed by name.
  const packed = JSON.parse(result.stdout);
  const [{ filename }] = Array.isArray(packed) ? packed : Object.values(packed);
  const bytes = readFileSync(path.join(tarballs, filename));
  return {
    manifest: readJson(path.join(dir, 'package.json')),
    file: path.join(tarballs, filename),
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    shasum: createHash('sha1').update(bytes).digest('hex'),
  };
}

// Serves packuments and tarballs for the packed packages; every other name is a 404, so
// npm never falls through to the public registry.
function startRegistry(packages) {
  const byName = new Map(packages.map((p) => [p.manifest.name, p]));
  const byFile = new Map(packages.map((p) => [path.basename(p.file), p]));
  const server = createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://registry').pathname);
    const tarball = url.startsWith('/-/') ? byFile.get(url.slice(3)) : undefined;
    if (tarball) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      createReadStream(tarball.file).pipe(res);
      return;
    }
    const entry = byName.get(url.slice(1));
    if (!entry) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}');
      return;
    }
    const { address, port } = server.address();
    const { manifest } = entry;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        name: manifest.name,
        'dist-tags': { latest: manifest.version },
        versions: {
          [manifest.version]: {
            ...manifest,
            _id: `${manifest.name}@${manifest.version}`,
            dist: {
              tarball: `http://${address}:${port}/-/${path.basename(entry.file)}`,
              integrity: entry.integrity,
              shasum: entry.shasum,
            },
          },
        },
      }),
    );
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// The environment of npm and toodo: nothing from the caller's HOME, npm config, or Toodo
// settings leaks in, and nothing is written outside the temporary directory.
function isolatedEnv(root, prefix, registry) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(npm_|TOODO_|XDG_|CODEX_HOME$)/i.test(key)) continue;
    env[key] = value;
  }
  const home = path.join(root, 'home');
  mkdirSync(home, { recursive: true });
  const userconfig = path.join(root, 'npmrc');
  writeFileSync(userconfig, '');
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    TMPDIR: root,
    PATH: `${path.join(prefix, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`,
    npm_config_userconfig: userconfig,
    npm_config_cache: path.join(root, 'npm-cache'),
    npm_config_prefix: prefix,
    npm_config_registry: registry,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  };
}

async function smoke(staged, root) {
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) {
    fail(`${process.platform}/${process.arch} has no toodo package; run this on Linux x64 or arm64.`);
  }
  const target = `toodo-linux-${process.arch}`;
  for (const name of ['toodo', target]) {
    if (!existsSync(path.join(staged, name, 'package.json'))) {
      fail(
        `${path.join(staged, name)} is not a staged package; stage it with ` +
          `node scripts/package-npm.mjs --out ${staged} --binaries linux-${process.arch}=<dir> ...`,
      );
    }
  }
  const { version } = readJson(path.join(staged, 'toodo', 'package.json'));

  const prefix = path.join(root, 'prefix');
  const tarballs = path.join(root, 'tarballs');
  mkdirSync(tarballs, { recursive: true });
  const packEnv = isolatedEnv(root, prefix, 'http://127.0.0.1:9/');
  const packages = [pack(path.join(staged, 'toodo'), tarballs, packEnv), pack(path.join(staged, target), tarballs, packEnv)];
  const registry = await startRegistry(packages);
  try {
    const { address, port: registryPort } = registry.address();
    const env = isolatedEnv(root, prefix, `http://${address}:${registryPort}/`);
    const spec = `@dubusoft/toodo@${version}`;

    step(`installing ${spec} into ${prefix}`);
    const install = await runInherited('npm', ['install', '-g', spec, '--include=optional'], { env });
    if (install !== 0) fail(`npm install -g ${spec} failed (exit ${install}); see the npm output above.`);
    const toodo = path.join(prefix, 'bin', 'toodo');
    if (!existsSync(toodo)) fail(`npm installed no ${toodo}; check "bin" in the staged toodo/package.json.`);
    const installed = path.join(prefix, 'lib', 'node_modules', '@dubusoft', 'toodo', 'node_modules', '@dubusoft', target);
    if (!existsSync(installed)) {
      fail(`npm did not install @dubusoft/${target} under @dubusoft/toodo; check "optionalDependencies" and "os"/"cpu"/"libc" in the staged package.json files.`);
    }

    const versionRun = run(toodo, ['--version'], { env });
    const reported = `${versionRun.stdout}${versionRun.stderr}`.trim();
    if (versionRun.status !== 0 || !reported.split(/\s+/).includes(version)) {
      fail(
        `toodo --version printed "${reported}" (exit ${versionRun.status}), not version ${version}; ` +
          `build the binaries with TOODO_VERSION=${version} set, as the npm workflow does, and stage them again.`,
      );
    }
    step(`toodo --version: ${reported}`);

    let port = await freePort();
    while (SERVER_PORTS.has(port)) port = await freePort();
    const data = path.join(root, 'data');
    const dataFlag = ['--data-dir', data];
    try {
      step(`running toodo init on port ${port}`);
      const init = run(toodo, ['init', '--no-mcp', '--port', String(port), ...dataFlag], { env });
      process.stdout.write(init.stdout);
      process.stderr.write(init.stderr);
      if (init.status !== 0) fail(`toodo init failed (exit ${init.status}); see its output above.`);
      if (init.stdout.includes('No web app')) {
        fail('toodo init started the server without the web app; check that the staged platform package has web/index.html.');
      }

      const status = run(toodo, ['status', ...dataFlag], { env });
      if (status.status !== 0) fail(`toodo status exited ${status.status}, not 0 (running):\n${status.stdout}${status.stderr}`);

      const base = `http://127.0.0.1:${port}`;
      const anonymous = await fetch(`${base}/api/rpc/list_tasks`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
      if (anonymous.status !== 401) fail(`POST /api/rpc/list_tasks without a token returned ${anonymous.status}, not 401.`);
      const token = readFileSync(path.join(data, 'web-token'), 'utf8').trim();
      const listed = await fetch(`${base}/api/rpc/list_tasks`, {
        method: 'POST',
        body: '{"filter":null}',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      });
      if (listed.status !== 200) fail(`POST /api/rpc/list_tasks with the web token returned ${listed.status}, not 200: ${await listed.text()}`);
      const page = await fetch(`${base}/`);
      const html = await page.text();
      if (page.status !== 200 || !html.includes('<div id="root"')) {
        fail(`GET / returned ${page.status} without the web app page; check web/ in the staged platform package.`);
      }
      step('the server answers: list_tasks is 401 without a token and 200 with it, / serves the web app');
    } catch (error) {
      const log = path.join(data, 'server.log');
      if (existsSync(log)) console.error(`--- ${log} ---\n${readFileSync(log, 'utf8').slice(-4000)}`);
      throw error;
    } finally {
      if (existsSync(path.join(data, 'server.pid'))) {
        const stop = run(toodo, ['stop', ...dataFlag], { env });
        if (stop.status !== 0) {
          const pid = Number(readFileSync(path.join(data, 'server.pid'), 'utf8').trim());
          console.error(`smoke-npm: toodo stop failed (exit ${stop.status}); killing pid ${pid}.\n${stop.stderr}`);
          if (pid > 0) process.kill(pid, 'SIGKILL');
        }
      }
    }
    step(`OK: ${spec} installs from npm and toodo init brings up a working server`);
  } finally {
    await new Promise((resolve) => registry.close(resolve));
  }
}

const args = parseArgs(process.argv.slice(2));
const root = mkdtempSync(path.join(tmpdir(), 'toodo-smoke-npm-'));
let code = 0;
try {
  await smoke(path.resolve(args.dir), root);
} catch (error) {
  if (!(error instanceof SmokeError)) throw error;
  console.error(`smoke-npm: FAILED: ${error.message}`);
  code = 1;
} finally {
  if (args.keep) step(`kept ${root}`);
  else rmSync(root, { recursive: true, force: true });
}
process.exit(code);
