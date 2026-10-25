import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { BotError } from '../src/client.js';
import { login, status, sendText, receive, contacts, inbox, logout } from '../src/bot.js';

async function fixture(t) {
  const stateDir = await mkdtemp(join(tmpdir(), 'weixin-test-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  return new Store({ stateDir });
}
const account = { token: 'bot-secret', account_id: 'bot', base_url: 'https://ilinkai.weixin.qq.com/', user_id: 'scanner' };
const message = (id, extra = {}) => ({ message_id: String(id), from_user_id: 'friend', to_user_id: 'bot',
  message_type: 1, message_state: 2, context_token: 'reply-secret', item_list: [{ type: 1, text_item: { text: `hello ${id}` } }], ...extra });
const factory = methods => () => ({ notify: async () => ({}), ...methods });

test('login persists QR across processes and saves confirmed credentials privately', async t => {
  const store = await fixture(t);
  const events = [];
  const clientFactory = factory({ getQr: async () => ({ qrcode: 'qr-secret', qrcode_img_content: 'https://weixin.qq.com/qr' }),
    qrStatus: async (qr, code) => {
      assert.equal(qr, 'qr-secret'); assert.equal(code, '123456');
      return { status: 'confirmed', bot_token: account.token, ilink_bot_id: account.account_id, ilink_user_id: account.user_id };
    } });
  assert.equal((await login(store, { noWait: true, clientFactory, onEvent: async event => events.push(event) })).event, 'login_pending');
  const result = await login(store, { clientFactory, verifyCode: '123456' });
  assert.equal(result.event, 'logged_in');
  assert.equal((await store.account()).token, 'bot-secret');
  assert.equal((await store.read('login')), null);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(JSON.stringify(events).includes('qr-secret'), false);
  assert.equal((await stat(join(store.dir, 'account.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(store.dir)).mode & 0o777, 0o700);
});

test('noninteractive verification is resumable and blocked codes remove pending login', async t => {
  const store = await fixture(t);
  const clientFactory = factory({ getQr: async () => ({ qrcode: 'q', qrcode_img_content: 'url' }),
    qrStatus: async () => ({ status: 'need_verifycode' }) });
  assert.equal((await login(store, { clientFactory })).event, 'verification_required');
  assert.ok(await store.read('login'));
  await assert.rejects(login(store, { clientFactory: factory({ qrStatus: async () => ({ status: 'verify_code_blocked' }) }) }), { code: 'VERIFY_BLOCKED' });
  assert.equal(await store.read('login'), null);
});

test('QR redirect changes polling host; confirmed baseurl controls authenticated API', async t => {
  const store = await fixture(t);
  const hosts = [];
  let calls = 0;
  const clientFactory = options => {
    hosts.push(options.baseUrl);
    return { getQr: async () => ({ qrcode: 'q', qrcode_img_content: 'url' }), qrStatus: async () => ++calls === 1
      ? { status: 'scaned_but_redirect', redirect_host: 'regional.weixin.qq.com' }
      : { status: 'confirmed', bot_token: 'secret', ilink_bot_id: 'bot', baseurl: 'https://api.weixin.qq.com' } };
  };
  await login(store, { clientFactory, pollIntervalMs: 0 });
  assert.ok(hosts.includes('https://regional.weixin.qq.com/'));
  assert.equal((await store.account()).base_url, 'https://api.weixin.qq.com/');
});

test('expired QR refreshes and resets verification; incomplete confirmation cannot create login', async t => {
  const store = await fixture(t);
  let qrCount = 0;
  let polls = 0;
  const clientFactory = factory({ getQr: async () => ({ qrcode: String(++qrCount), qrcode_img_content: 'url' }),
    qrStatus: async (qr, code) => {
      if (++polls === 1) return { status: 'expired' };
      assert.equal(qr, '2'); assert.equal(code, undefined);
      return { status: 'confirmed', ilink_bot_id: 'bot' };
    } });
  await assert.rejects(login(store, { clientFactory, verifyCode: 'old', pollIntervalMs: 0 }), { code: 'INVALID_RESPONSE' });
  assert.equal(await store.read('account'), null);
});

test('already-bound without local credentials is not reported as success', async t => {
  const store = await fixture(t);
  await assert.rejects(login(store, { clientFactory: factory({ getQr: async () => ({ qrcode: 'q', qrcode_img_content: 'url' }),
    qrStatus: async () => ({ status: 'binded_redirect' }) }) }), { code: 'MISSING_CREDENTIALS' });
});

test('switching bots clears old cursors and reply contexts', async t => {
  const store = await fixture(t);
  await store.write('account', account);
  await store.write('sync', { ...(await store.sync()), cursor: 'old-cursor' });
  await login(store, { force: true, clientFactory: factory({ getQr: async () => ({ qrcode: 'q', qrcode_img_content: 'url' }),
    qrStatus: async () => ({ status: 'confirmed', bot_token: 'new', ilink_bot_id: 'new-bot' }) }) });
  assert.equal((await store.sync()).cursor, '');
  assert.equal((await store.account()).account_id, 'new-bot');
});

test('receive stores cursor and context, then a new instance sends with that context', async t => {
  const store = await fixture(t);
  await store.write('account', account);
  const output = [];
  await receive(store, { clientFactory: factory({ updates: async cursor => {
    assert.equal(cursor, ''); return { msgs: [message(1)], get_updates_buf: 'cursor-1' };
  } }), onMessage: async msg => output.push(msg) });
  assert.equal(output[0].text, 'hello 1');
  assert.equal(output[0].context_token, undefined);
  assert.equal((await store.sync()).cursor, 'cursor-1');
  assert.deepEqual((await contacts(store)).contacts.map(contact => contact.user_id), ['friend']);
  assert.equal(JSON.stringify(await contacts(store)).includes('reply-secret'), false);
  let sent;
  const fresh = new Store({ stateDir: join(store.dir, '..') });
  const result = await sendText(fresh, { to: 'friend', text: '收到', clientFactory: options => {
    assert.equal(options.token, 'bot-secret');
    return { send: async msg => { sent = msg; return { message_id: 'server-id' }; } };
  } });
  assert.equal(sent.context_token, 'reply-secret');
  assert.equal(sent.message_type, 2);
  assert.equal(sent.message_state, 2);
  assert.equal(sent.item_list[0].text_item.text, '收到');
  assert.equal(result.message_id, 'server-id');
  await receive(fresh, { clientFactory: factory({ updates: async cursor => {
    assert.equal(cursor, 'cursor-1'); return { msgs: [], get_updates_buf: '' };
  } }) });
  assert.equal((await store.sync()).cursor, 'cursor-1');
});

test('max-messages preserves the un-emitted batch and later drains without a network request', async t => {
  const store = await fixture(t);
  await store.write('account', account);
  await receive(store, { maxMessages: 1, clientFactory: factory({ updates: async () => ({ msgs: [message(1), message(2), message(3)], get_updates_buf: 'all' }) }) });
  assert.equal((await store.sync()).pending.length, 2);
  const output = [];
  await receive(store, { clientFactory: factory({ updates: async () => { throw new Error('must not poll'); } }), onMessage: async msg => output.push(msg) });
  assert.deepEqual(output.map(msg => msg.message_id), ['2', '3']);
  assert.equal((await store.sync()).pending.length, 0);
  assert.equal((await inbox(store)).messages.length, 3);
});

test('failed output preserves pending messages and cursor for replay', async t => {
  const store = await fixture(t);
  await store.write('account', account);
  await assert.rejects(receive(store, {
    clientFactory: factory({ updates: async () => ({ msgs: [message(1)], get_updates_buf: 'persisted' }) }),
    onMessage: async () => { throw new Error('broken pipe'); },
  }), /broken pipe/);
  const sync = await store.sync();
  assert.equal(sync.cursor, 'persisted');
  assert.equal(sync.pending.length, 1);
  assert.equal((await status(store)).logged_in, true);
});

test('duplicates are suppressed, bot echoes ignored, media preserved, new context cached', async t => {
  const store = await fixture(t);
  await store.write('account', account);
  const image = message(2, { item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'image' } } }] });
  const voice = message(3, { item_list: [{ type: 3, voice_item: { text: '转写' } }] });
  const batch = [message(1), message(1, { context_token: 'updated' }), image, voice,
    message(99, { message_type: 2, from_user_id: 'bot', context_token: 'wrong' })];
  const received = [];
  const clientFactory = factory({ updates: async () => ({ msgs: batch }) });
  await receive(store, { clientFactory, onMessage: async msg => received.push(msg) });
  await receive(store, { clientFactory, onMessage: async msg => received.push(msg) });
  assert.equal(received.length, 3);
  assert.equal(received[1].item_list[0].image_item.media.encrypt_query_param, 'image');
  assert.equal(received[2].text, '转写');
  assert.equal((await store.sync()).contacts.friend.context_token, 'reply-secret');
  assert.equal((await store.sync()).contacts.bot, undefined);
});

test('invalid messages do not advance cursor; stale session exits without retrying', async t => {
  const store = await fixture(t);
  await store.write('account', account);
  await assert.rejects(receive(store, { clientFactory: factory({ updates: async () => ({ msgs: [null], get_updates_buf: 'bad' }) }) }), { code: 'INVALID_RESPONSE' });
  assert.equal((await store.sync()).cursor, '');
  let calls = 0;
  await assert.rejects(receive(store, { watch: true, clientFactory: factory({ updates: async () => {
    calls++; throw new BotError('SESSION_EXPIRED', 'expired');
  } }) }), { code: 'SESSION_EXPIRED' });
  assert.equal(calls, 1);
});

test('watch handles poll timeouts, follows server timeout, and stops cleanly', async t => {
  const store = await fixture(t);
  await store.write('account', account);
  const controller = new AbortController();
  let calls = 0;
  const result = await receive(store, { watch: true, pollIntervalMs: 0, signal: controller.signal,
    clientFactory: factory({ updates: async (_cursor, options) => {
      if (++calls === 1) throw new BotError('TIMEOUT', 'timeout', { retryable: true });
      if (calls === 2) return { msgs: [], longpolling_timeout_ms: 1200 };
      assert.equal(options.timeoutMs, 1200);
      return { msgs: [message(1)] };
    } }), onMessage: async () => controller.abort(),
  });
  assert.equal(result.event, 'stopped');
  assert.equal(result.count, 1);
});

test('missing context blocks sends; explicit context works and uncertain sends never retry', async t => {
  const store = await fixture(t);
  await store.write('account', account);
  await assert.rejects(sendText(store, { to: 'friend', text: 'hi' }), { code: 'MISSING_CONTEXT' });
  let calls = 0;
  await assert.rejects(sendText(store, { to: 'friend', text: 'hi', contextToken: 'manual', clientFactory: factory({ send: async msg => {
    calls++; assert.equal(msg.context_token, 'manual'); throw new BotError('TIMEOUT', 'uncertain', { retryable: true });
  } }) }), { code: 'TIMEOUT' });
  assert.equal(calls, 1);
});

test('watch recovers from temporary network errors and keeps unidentified duplicate texts', async t => {
  const store = await fixture(t);
  await store.write('account', account);
  let calls = 0;
  let warnings = 0;
  const received = [];
  const unidentified = message(1);
  delete unidentified.message_id;
  const result = await receive(store, { watch: true, maxMessages: 2, pollIntervalMs: 0,
    onWarning: async () => { warnings++; }, onMessage: async msg => received.push(msg),
    clientFactory: factory({ updates: async () => {
      if (++calls === 1) throw new BotError('NETWORK_ERROR', 'temporary', { retryable: true });
      return { msgs: [unidentified, unidentified] };
    } }),
  });
  assert.equal(warnings, 1);
  assert.equal(calls, 2);
  assert.equal(result.count, 2);
  assert.equal(received.length, 2);
});

test('profiles isolate credentials; lock prevents concurrent receiving and logout clears data', async t => {
  const store = await fixture(t);
  await store.write('account', account);
  const other = new Store({ stateDir: join(store.dir, '..'), profile: 'other' });
  await assert.rejects(other.account(), { code: 'NOT_LOGGED_IN' });
  assert.throws(() => new Store({ profile: '../escape' }), { code: 'INVALID_PROFILE' });
  await store.lock('receive', async () => {
    await assert.rejects(receive(store), { code: 'BUSY' });
    await assert.rejects(logout(store), { code: 'BUSY' });
  });
  await logout(store);
  assert.equal((await status(store)).logged_in, false);
});

test('corrupt state is surfaced instead of silently resetting cursor', async t => {
  const store = await fixture(t);
  await store.init();
  await writeFile(join(store.dir, 'sync.json'), 'broken');
  await assert.rejects(store.sync(), { code: 'STATE_ERROR' });
  await store.write('sync', {});
  await assert.rejects(store.sync(), { code: 'STATE_ERROR' });
});
