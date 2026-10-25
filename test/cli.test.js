import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile, access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';

const exec = promisify(execFile);
const entry = fileURLToPath(new URL('../bin/weixin-bot.js', import.meta.url));
const events = stdout => stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

async function sandbox(t) {
  const directory = await mkdtemp(join(tmpdir(), 'weixin-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const run = async (args, launcher = entry) => {
    try { return { ...(await exec(process.execPath, [launcher, ...args, '--state-dir', directory], { timeout: 15_000 })), code: 0 }; }
    catch (error) { return { stdout: error.stdout, stderr: error.stderr, code: error.code }; }
  };
  return { directory, run };
}

async function mockServer(t, handler) {
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    try {
      const result = await handler({ url: new URL(req.url, 'http://localhost'), method: req.method,
        headers: req.headers, body: raw ? JSON.parse(raw) : undefined, res });
      if (!res.writableEnded && result !== undefined) {
        res.setHeader('Content-Type', 'application/json');
        res.end(typeof result === 'string' ? result : JSON.stringify(result));
      }
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('CLI end-to-end: QR, verification, login, receive, send text/file/stdin, logout', async t => {
  const { directory, run } = await sandbox(t);
  const sent = [];
  let polls = 0;
  let baseUrl;
  baseUrl = await mockServer(t, async req => {
    const path = req.url.pathname;
    if (path.endsWith('/get_bot_qrcode')) {
      assert.equal(req.headers.authorization, undefined);
      assert.deepEqual(req.body, { local_token_list: [] });
      return { qrcode: 'fake-qr', qrcode_img_content: 'https://example.com/login' };
    }
    if (path.endsWith('/get_qrcode_status')) {
      assert.equal(req.method, 'GET');
      assert.equal(req.headers.authorization, undefined);
      if (req.url.searchParams.get('verify_code') !== '123456') return { status: 'need_verifycode' };
      return { status: 'confirmed', bot_token: 'mock-secret', ilink_bot_id: 'bot', ilink_user_id: 'user', baseurl: baseUrl };
    }
    assert.equal(req.headers.authorization, 'Bearer mock-secret');
    assert.equal(req.body.base_info.bot_agent, 'WeixinBotCLI/0.1.0');
    if (path.endsWith('/getupdates')) {
      if (++polls === 1) {
        assert.equal(req.body.get_updates_buf, '');
        return '{"ret":0,"get_updates_buf":"cursor-1","msgs":[{"message_id":18446744073709551615,"from_user_id":"friend","message_type":1,"context_token":"context-secret","item_list":[{"type":1,"text_item":{"text":"你好"}}]}]}';
      }
      assert.equal(req.body.get_updates_buf, 'cursor-1');
      return { ret: 0, msgs: [], get_updates_buf: 'cursor-2' };
    }
    if (path.endsWith('/sendmessage')) {
      assert.equal(req.body.msg.context_token, 'context-secret');
      sent.push(req.body.msg);
      return '{"ret":0,"message_id":18446744073709551614}';
    }
    return { ret: 0 };
  });
  let result = await run(['login', '--base-url', baseUrl, '--no-wait', '--json']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(events(result.stdout)[0].event, 'qrcode');
  assert.equal(result.stderr, '');
  result = await run(['login', '--json']);
  assert.equal(result.code, 2);
  assert.equal(events(result.stdout).at(-1).event, 'verification_required');
  result = await run(['login', '--verify-code', '123456', '--json']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(events(result.stdout).at(-1).event, 'logged_in');
  assert.equal(result.stdout.includes('mock-secret'), false);
  result = await run(['receive', '--once', '--json']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(events(result.stdout)[0].message_id, '18446744073709551615');
  assert.equal(events(result.stdout)[0].text, '你好');
  assert.equal(result.stdout.includes('context-secret'), false);
  assert.equal((await run(['receive', '--json'])).code, 0);
  result = await run(['send', '--to', 'friend', '--text', '你好，收到']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(events(result.stdout)[0].message_id, '18446744073709551614');
  const textPath = join(directory, 'text.txt');
  await writeFile(textPath, '第一行\n第二行');
  assert.equal((await run(['send', '--to', 'friend', '--file', textPath])).code, 0);
  const stdinResult = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, 'send', '--to', 'friend', '--stdin', '--state-dir', directory]);
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdout.resume();
    child.on('error', reject);
    child.on('exit', code => resolve({ code, stderr }));
    child.stdin.end('管道文本');
  });
  assert.equal(stdinResult.code, 0, stdinResult.stderr);
  assert.deepEqual(sent.map(msg => msg.item_list[0].text_item.text), ['你好，收到', '第一行\n第二行', '管道文本']);
  assert.equal(events((await run(['contacts'])).stdout)[0].contacts[0].user_id, 'friend');
  assert.equal(events((await run(['inbox'])).stdout)[0].messages.length, 1);
  assert.equal((await run(['logout'])).code, 0);
  assert.equal(events((await run(['status'])).stdout)[0].logged_in, false);
});

test('CLI rejects invalid or mixed options before sending', async t => {
  const { run } = await sandbox(t);
  for (const args of [['send', '--to', 'friend', '--text', 'a', '--stdin'], ['receive', '--timeout', 'NaN'],
    ['receive', '--once', '--watch'], ['status', '--force'], ['send', '--text', 'a'], ['unknown'], ['status', '--profile', '../escape']]) {
    const result = await run(args);
    assert.equal(result.code, 1, JSON.stringify(args));
    assert.equal(result.stdout, '');
    assert.ok(JSON.parse(result.stderr).error.code);
  }
});

test('installed skill is self-contained and an existing directory is never overwritten', async t => {
  const { directory, run } = await sandbox(t);
  const dest = join(directory, 'installed-skill');
  let result = await run(['skill', 'install', '--dir', dest]);
  assert.equal(result.code, 0, result.stderr);
  const launcher = events(result.stdout)[0].launcher;
  assert.equal(launcher, join(dest, 'scripts', 'weixin-bot.mjs'));
  assert.match(await readFile(join(dest, 'SKILL.md'), 'utf8'), /name: weixin-bot/);
  await access(join(dest, 'runtime', 'node_modules', 'qrcode-terminal', 'lib', 'main.js'));
  result = await run(['status', '--json'], launcher);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(events(result.stdout)[0].logged_in, false);
  result = await run(['skill', 'install', '--dir', dest]);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stderr).error.code, 'ALREADY_EXISTS');
  // Reinstallation from the copied runtime also works without reaching the source repo.
  result = await run(['skill', 'install', '--dir', join(directory, 'second-skill')], launcher);
  assert.equal(result.code, 0, result.stderr);
});

test('SIGTERM aborts an active long poll and releases the receiver lock', { timeout: 10_000 }, async t => {
  const { directory } = await sandbox(t);
  let onPoll;
  const polling = new Promise(resolve => { onPoll = resolve; });
  const baseUrl = await mockServer(t, async req => {
    if (req.url.pathname.endsWith('/getupdates')) { onPoll(); return undefined; }
    return { ret: 0 };
  });
  const store = new Store({ stateDir: directory });
  await store.write('account', { token: 'secret', account_id: 'bot', base_url: baseUrl });
  const child = spawn(process.execPath, [entry, 'receive', '--watch', '--json', '--state-dir', directory]);
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => child.on('exit', resolve));
  await polling;
  child.kill('SIGTERM');
  assert.equal(await exited, 0, stderr);
  assert.equal(events(stdout).at(-1).event, 'stopped');
  await assert.rejects(access(join(store.dir, 'receive.lock')), { code: 'ENOENT' });
});
