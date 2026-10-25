import test from 'node:test';
import assert from 'node:assert/strict';
import { access, cp, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { installOneClick } from '../src/install.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const script = join(root, 'install.sh');

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'weixin-install-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, options: { skillDir: join(dir, "agent's skills", 'weixin-bot'),
    binDir: join(dir, 'local bin'), backupDir: join(dir, 'backups') } };
}

test('one-click install provides a standalone skill and working CLI for paths with spaces', async t => {
  const { options } = await fixture(t);
  const result = await installOneClick(options);
  assert.equal(result.event, 'installed');
  assert.equal(await readlink(result.executable), result.launcher);
  assert.equal((await exec(result.executable, ['--version'])).stdout.trim(), '0.1.0');
  await access(join(options.skillDir, 'runtime', 'node_modules', 'qrcode-terminal', 'lib', 'main.js'));
  await assert.rejects(access(`${options.skillDir}.install.lock`), { code: 'ENOENT' });
});

test('reinstall backs up all old files and updates the skill without changing login data', async t => {
  const { dir, options } = await fixture(t);
  const state = join(dir, '.weixin-bot', 'default');
  await mkdir(state, { recursive: true });
  await writeFile(join(state, 'account.json'), '{"token":"test-credential"}');
  await installOneClick(options);
  const modified = `${await readFile(join(options.skillDir, 'SKILL.md'), 'utf8')}\nLocal instructions\n`;
  await writeFile(join(options.skillDir, 'SKILL.md'), modified);
  await writeFile(join(options.skillDir, 'personal.txt'), 'keep this');
  const result = await installOneClick(options);
  assert.equal(result.event, 'updated');
  assert.equal(await readFile(join(result.backup, 'SKILL.md'), 'utf8'), modified);
  assert.equal(await readFile(join(result.backup, 'personal.txt'), 'utf8'), 'keep this');
  assert.equal(await readFile(join(options.skillDir, 'SKILL.md'), 'utf8'), await readFile(join(root, 'skills', 'weixin-bot', 'SKILL.md'), 'utf8'));
  assert.equal(await readFile(join(state, 'account.json'), 'utf8'), '{"token":"test-credential"}');
  assert.equal((await exec(result.executable, ['--version'])).stdout.trim(), '0.1.0');
});

test('a failed CLI link restores the complete prior skill', async t => {
  const { options } = await fixture(t);
  await installOneClick({ ...options, noBin: true });
  await writeFile(join(options.skillDir, 'custom.txt'), 'old version');
  await assert.rejects(installOneClick(options, { createLink: async () => {
    throw Object.assign(new Error('injected link failure'), { code: 'EACCES' });
  } }), { code: 'EACCES' });
  assert.equal(await readFile(join(options.skillDir, 'custom.txt'), 'utf8'), 'old version');
  assert.equal((await exec(process.execPath, [join(options.skillDir, 'scripts', 'weixin-bot.mjs'), '--version'])).stdout.trim(), '0.1.0');
  assert.equal((await readdir(options.backupDir)).length, 1);
  await assert.rejects(access(join(options.binDir, 'weixin-bot')), { code: 'ENOENT' });
  await assert.rejects(access(`${options.skillDir}.install.lock`), { code: 'ENOENT' });
});

test('unknown skills, symlink destinations and unrelated binaries are preserved', async t => {
  const { dir, options } = await fixture(t);
  await mkdir(options.skillDir, { recursive: true });
  await writeFile(join(options.skillDir, 'keep.txt'), 'unrelated');
  await assert.rejects(installOneClick(options), { code: 'INSTALL_CONFLICT' });
  assert.equal(await readFile(join(options.skillDir, 'keep.txt'), 'utf8'), 'unrelated');
  await rm(options.skillDir, { recursive: true });
  await symlink(join(dir, 'missing'), options.skillDir);
  await assert.rejects(installOneClick(options), { code: 'INSTALL_CONFLICT' });
  assert.equal(await readlink(options.skillDir), join(dir, 'missing'));
  await rm(options.skillDir);
  await mkdir(options.binDir, { recursive: true });
  await writeFile(join(options.binDir, 'weixin-bot'), 'another command');
  await assert.rejects(installOneClick(options), { code: 'INSTALL_CONFLICT' });
  assert.equal(await readFile(join(options.binDir, 'weixin-bot'), 'utf8'), 'another command');
  await assert.rejects(access(options.skillDir), { code: 'ENOENT' });
});

test('only-skill installation, overlapping paths and concurrent installers', async t => {
  const { options } = await fixture(t);
  const result = await installOneClick({ ...options, noBin: true });
  assert.equal(result.executable, undefined);
  await assert.rejects(access(options.binDir), { code: 'ENOENT' });
  await assert.rejects(installOneClick({ ...options, backupDir: join(options.skillDir, 'backup') }), { code: 'INVALID_ARGUMENT' });
  await mkdir(`${options.skillDir}.install.lock`);
  await assert.rejects(installOneClick(options), { code: 'BUSY' });
  await access(`${options.skillDir}.install.lock`);
});

async function bootstrapFixture(t) {
  const fixtureData = await fixture(t);
  const { dir } = fixtureData;
  const source = join(dir, 'package');
  await mkdir(source);
  for (const name of ['bin', 'src', 'skills', 'scripts', 'install.sh', 'package.json', 'package-lock.json', 'LICENSE', 'NOTICE']) {
    await cp(join(root, name), join(source, name), { recursive: true });
  }
  const archive = join(dir, 'source.tar.gz');
  await exec('tar', ['-czf', archive, '-C', dir, 'package']);
  const stubs = join(dir, 'stubs');
  await mkdir(stubs);
  const stub = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const command = path.basename(process.argv[1]);
fs.appendFileSync(process.env.WEIXIN_INSTALL_TEST_LOG, JSON.stringify({command,args,cwd:process.cwd()})+'\\n');
if (process.env.WEIXIN_INSTALL_TEST_FAIL === command) process.exit(22);
if (command === 'curl') {
  fs.copyFileSync(process.env.WEIXIN_INSTALL_TEST_ARCHIVE, args[args.indexOf('-o')+1]);
} else {
  fs.cpSync(process.env.WEIXIN_INSTALL_TEST_QR, path.join(process.cwd(),'node_modules','qrcode-terminal'), {recursive:true});
}
`;
  for (const command of ['curl', 'npm']) await writeFile(join(stubs, command), stub, { mode: 0o755 });
  const log = join(dir, 'commands.ndjson');
  const env = { ...process.env, PATH: `${stubs}${delimiter}${process.env.PATH}`,
    WEIXIN_INSTALL_TEST_LOG: log, WEIXIN_INSTALL_TEST_ARCHIVE: archive,
    WEIXIN_INSTALL_TEST_QR: join(root, 'node_modules', 'qrcode-terminal') };
  const args = ['--skill-dir', fixtureData.options.skillDir, '--bin-dir', fixtureData.options.binDir, '--backup-dir', fixtureData.options.backupDir];
  return { ...fixtureData, stubs, log, env, args };
}

test('bootstrap runs the full download/install flow and forwards quoted paths and ref', async t => {
  const { options, args, env, log } = await bootstrapFixture(t);
  const result = await exec('bash', ['-c', 'set -o pipefail; cat "$1" | bash -s -- "${@:2}"',
    'weixin-install-test', script, '--ref', 'feature/install', ...args], { env, timeout: 15_000 });
  assert.match(result.stdout, /安装完成/);
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(calls[0].args.includes('https://codeload.github.com/dairoot/weixin-bot-cli/tar.gz/feature%2Finstall'));
  assert.equal(calls[1].command, 'npm');
  for (const flag of ['ci', '--ignore-scripts', '--omit=dev']) assert.ok(calls[1].args.includes(flag));
  const download = calls[0].args[calls[0].args.indexOf('-o') + 1];
  assert.equal(calls[1].args.includes('--prefix'), false);
  // npm must run inside the extracted package, including when curl pipes to bash.
  assert.equal(calls[1].cwd.endsWith(`${dirname(download).split('/').at(-1)}/source`), true);
  await assert.rejects(access(dirname(download)), { code: 'ENOENT' });
  assert.equal((await exec(join(options.binDir, 'weixin-bot'), ['--version'])).stdout.trim(), '0.1.0');
  // The emitted PATH line uses valid shell quoting even with spaces/apostrophes.
  const pathLine = result.stdout.split('\n').find(line => line.startsWith('export PATH='));
  const found = await exec('bash', ['-c', `${pathLine}\ncommand -v weixin-bot`]);
  assert.equal(found.stdout.trim(), join(options.binDir, 'weixin-bot'));
});

test('bootstrap download and dependency failures never replace an existing skill', async t => {
  const { options, args, env, log } = await bootstrapFixture(t);
  await installOneClick(options);
  await writeFile(join(options.skillDir, 'custom.txt'), 'preserve');
  for (const command of ['curl', 'npm']) {
    await assert.rejects(exec('bash', [script, ...args], { env: { ...env, WEIXIN_INSTALL_TEST_FAIL: command }, timeout: 15_000 }));
    assert.equal(await readFile(join(options.skillDir, 'custom.txt'), 'utf8'), 'preserve');
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
    const download = calls.filter(call => call.command === 'curl').at(-1);
    await assert.rejects(access(dirname(download.args[download.args.indexOf('-o') + 1])), { code: 'ENOENT' });
  }
});

test('bootstrap refuses old Node and invalid flags before downloading', async t => {
  const { options, stubs, env, log } = await bootstrapFixture(t);
  await writeFile(join(stubs, 'node'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo v20.0.0; else exit 1; fi\n', { mode: 0o755 });
  await assert.rejects(exec('bash', [script], { env }), error => error.stderr.includes('需要 Node.js >=22.13.0'));
  await assert.rejects(exec('bash', [script, '--bad-option'], { env }), error => error.stderr.includes('未知选项'));
  await assert.rejects(exec('bash', [script, '--skill-dir'], { env }), error => error.stderr.includes('缺少参数'));
  await assert.rejects(access(log), { code: 'ENOENT' });
  await assert.rejects(access(options.skillDir), { code: 'ENOENT' });
  assert.match((await exec('bash', [script, '--help'], { env })).stdout, /一键|curl -fsSL/);
});
