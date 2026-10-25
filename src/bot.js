import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, BotError, DEFAULT_BASE_URL, validateBaseUrl } from './client.js';

const pause = async (ms, signal) => {
  try { await delay(ms, undefined, { signal }); }
  catch { throw new BotError('CANCELLED', '操作已取消。'); }
};

export const publicAccount = (account, profile) => ({
  profile, account_id: account.account_id, user_id: account.user_id,
  base_url: account.base_url, logged_in_at: account.logged_in_at,
});

export async function status(store) {
  const account = await store.read('account');
  return { logged_in: Boolean(account?.token), checked: 'local',
    ...(account?.token ? publicAccount(account, store.profile) : { profile: store.profile }) };
}

export async function login(store, {
  baseUrl = DEFAULT_BASE_URL, routeTag, force = false, noWait = false,
  verifyCode, timeoutMs = 480_000, signal, onEvent = async () => {}, readCode,
  clientFactory = options => new Client(options), pollIntervalMs = 1000,
} = {}) {
  return store.lock('receive', async () => {
    const account = await store.read('account');
    let pending = await store.read('login');
    if (force || (pending && Date.now() - pending.created_at > 300_000)) pending = null;
    if (!force && !pending && account?.token) return { event: 'already_logged_in', ...publicAccount(account, store.profile) };
    const initialBaseUrl = validateBaseUrl(pending?.initial_base_url || baseUrl);
    const deadline = Date.now() + timeoutMs;
    let refreshes = 0;
    const start = async () => {
      const client = clientFactory({ baseUrl: initialBaseUrl, routeTag });
      const qr = await client.getQr(account?.token ? [account.token] : [], { signal, timeoutMs: Math.min(15_000, Math.max(1, deadline - Date.now())) });
      if (!qr.qrcode || !qr.qrcode_img_content) throw new BotError('INVALID_RESPONSE', '服务器未返回完整二维码。');
      pending = { qrcode: qr.qrcode, qrcode_url: qr.qrcode_img_content,
        base_url: initialBaseUrl, initial_base_url: initialBaseUrl, created_at: Date.now() };
      await store.write('login', pending);
    };
    if (!pending) await start();
    await onEvent({ event: 'qrcode', qrcode_url: pending.qrcode_url,
      expires_at: new Date(pending.created_at + 300_000).toISOString() });
    if (noWait) return { event: 'login_pending', profile: store.profile };
    let code = verifyCode;
    while (Date.now() < deadline) {
      const client = clientFactory({ baseUrl: pending.base_url, routeTag });
      let result;
      try {
        result = await client.qrStatus(pending.qrcode, code, {
          signal, timeoutMs: Math.min(35_000, Math.max(1, deadline - Date.now())),
        });
      } catch (error) {
        if (!error.retryable) throw error;
        await onEvent({ event: 'retry', code: error.code });
        await pause(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())), signal);
        continue;
      }
      switch (result.status) {
        case 'confirmed': {
          if (!result.bot_token || !result.ilink_bot_id) throw new BotError('INVALID_RESPONSE', '登录确认缺少 bot_token 或 ilink_bot_id。');
          const next = { token: result.bot_token, account_id: result.ilink_bot_id,
            user_id: result.ilink_user_id, base_url: validateBaseUrl(result.baseurl || pending.base_url),
            logged_in_at: new Date().toISOString() };
          // Never reuse another bot's cursor or conversation context.
          if (account?.account_id !== next.account_id) await store.remove('sync');
          await store.write('account', next);
          await store.remove('login');
          return { event: 'logged_in', ...publicAccount(next, store.profile) };
        }
        case 'binded_redirect':
          if (!account?.token || (result.ilink_bot_id && account.account_id !== result.ilink_bot_id)) {
            throw new BotError('MISSING_CREDENTIALS', '服务器提示已绑定，但当前 profile 没有对应凭证；请在微信解除旧绑定后重新登录。');
          }
          await store.remove('login');
          return { event: 'already_logged_in', ...publicAccount(account, store.profile) };
        case 'need_verifycode':
          if (!readCode) return { event: 'verification_required', profile: store.profile,
            message: '请运行 login --verify-code <手机微信显示的数字> 继续。' };
          code = (await readCode({ timeoutMs: Math.max(1, deadline - Date.now()), signal })).trim();
          if (!code) throw new BotError('INVALID_CODE', '验证码不能为空。');
          continue;
        case 'verify_code_blocked':
          await store.remove('login');
          throw new BotError('VERIFY_BLOCKED', '验证码错误次数过多，请稍后运行 login --force 重新扫码。');
        case 'expired':
          if (++refreshes > 2) {
            await store.remove('login');
            throw new BotError('QR_EXPIRED', '二维码多次过期，请重新运行 login。');
          }
          code = undefined;
          await start();
          await onEvent({ event: 'qrcode', qrcode_url: pending.qrcode_url });
          continue;
        case 'scaned_but_redirect': {
          if (!result.redirect_host) throw new BotError('INVALID_RESPONSE', '登录重定向缺少 redirect_host。');
          const target = new URL(`https://${result.redirect_host}`);
          if (target.host !== result.redirect_host || target.pathname !== '/') throw new BotError('INVALID_RESPONSE', '登录重定向主机无效。');
          pending.base_url = validateBaseUrl(target.href);
          await store.write('login', pending);
          break;
        }
        case 'scaned':
          code = undefined;
          await onEvent({ event: 'scanned' });
          break;
        case 'wait': break;
        default: throw new BotError('INVALID_RESPONSE', '服务器返回了未知登录状态。');
      }
      await pause(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())), signal);
    }
    throw new BotError('LOGIN_TIMEOUT', '登录等待超时，可运行 login 继续或 login --force 重新扫码。');
  });
}

export async function sendText(store, { to, text, contextToken, allowWithoutContext = false,
  clientId = `weixin-bot-${randomUUID()}`, routeTag, signal, clientFactory = options => new Client(options) }) {
  if (!to?.trim() || !text?.trim()) throw new BotError('INVALID_ARGUMENT', '发送消息需要非空 --to 和文本。');
  const account = await store.account();
  const sync = await store.sync();
  const contact = Object.hasOwn(sync.contacts, to) ? sync.contacts[to] : undefined;
  const context = contextToken || contact?.context_token;
  if (!context && !allowWithoutContext) throw new BotError('MISSING_CONTEXT', '未找到收件人的会话令牌。请让对方先给 Bot 发消息，再运行 receive；也可显式提供 --context-token。');
  const client = clientFactory({ baseUrl: account.base_url, token: account.token, routeTag });
  // Never retry a send automatically: a timeout may occur after server acceptance.
  const response = await client.send({ from_user_id: '', to_user_id: to, client_id: clientId,
    message_type: 2, message_state: 2, ...(context ? { context_token: context } : {}),
    item_list: [{ type: 1, text_item: { text } }],
  }, { signal });
  return { event: 'sent', to, client_id: clientId, ...(response.message_id ? { message_id: response.message_id } : {}) };
}

export function publicMessage(raw) {
  const { context_token: _context, ...message } = raw;
  const text = (raw.item_list || []).map(item => item.text_item?.text || item.voice_item?.text || '').filter(Boolean).join('\n');
  return { event: 'message', ...message, text };
}

function messageKey(message) {
  // Without an identifier, two identical texts can be separate real messages.
  if (message.message_id == null && !message.client_id && message.seq == null) return randomUUID();
  return createHash('sha256').update(JSON.stringify([
    message.from_user_id, message.to_user_id, message.group_id, message.message_id,
    message.client_id, message.seq, message.message_state, message.update_time_ms,
    message.create_time_ms, message.item_list,
  ])).digest('hex');
}

export async function receive(store, { watch = false, timeoutMs = 35_000, maxMessages = Infinity,
  routeTag, signal, onMessage = async () => {}, onWarning = async () => {},
  clientFactory = options => new Client(options), pollIntervalMs = 250,
} = {}) {
  return store.lock('receive', async () => {
    const account = await store.account();
    const client = clientFactory({ baseUrl: account.base_url, token: account.token, routeTag });
    const sync = await store.sync();
    let count = 0;
    let failures = 0;
    let nextTimeout = timeoutMs;
    const drain = async () => {
      while (sync.pending.length && count < maxMessages && !signal?.aborted) {
        await onMessage(publicMessage(sync.pending[0]));
        sync.pending.shift();
        await store.write('sync', sync);
        count++;
      }
    };
    await drain();
    if (count && (!watch || count >= maxMessages)) return { event: 'poll_complete', count };
    try {
      try { await client.notify(true, { signal }); }
      catch (error) { if (error.code === 'CANCELLED') throw error; await onWarning(error); }
      do {
        if (signal?.aborted) break;
        let response;
        try {
          response = await client.updates(sync.cursor, { timeoutMs: nextTimeout, signal });
          failures = 0;
        } catch (error) {
          if (error.code === 'CANCELLED') break;
          if (error.code === 'TIMEOUT') { response = { msgs: [] }; }
          else {
            if (!watch || !error.retryable) throw error;
            await onWarning(error);
            await pause(Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)), signal);
            continue;
          }
        }
        if (response.msgs !== undefined && (!Array.isArray(response.msgs) || response.msgs.some(msg =>
          !msg || typeof msg !== 'object' || Array.isArray(msg) ||
          (msg.item_list !== undefined && (!Array.isArray(msg.item_list) || msg.item_list.some(item => !item || typeof item !== 'object')))))) {
          throw new BotError('INVALID_RESPONSE', '服务器消息格式无效，接收游标未更新。');
        }
        const seen = new Set(sync.seen);
        for (const message of response.msgs || []) {
          // Bot echoes must not replace the inbound reply context or trigger a reply loop.
          if (message.message_type === 2 || message.from_user_id === account.account_id) continue;
          if (message.from_user_id && message.context_token && !message.group_id) {
            Object.defineProperty(sync.contacts, message.from_user_id, { enumerable: true, configurable: true, writable: true,
              value: { user_id: message.from_user_id, context_token: message.context_token,
                last_seen_at: new Date().toISOString() } });
          }
          const key = messageKey(message);
          if (seen.has(key)) continue;
          seen.add(key);
          sync.seen.push(key);
          sync.pending.push(message);
          sync.history.push(message);
        }
        sync.seen = sync.seen.slice(-2000);
        sync.history = sync.history.slice(-1000);
        if (typeof response.get_updates_buf === 'string' && response.get_updates_buf) sync.cursor = response.get_updates_buf;
        if (Number.isFinite(response.longpolling_timeout_ms) && response.longpolling_timeout_ms > 0) {
          nextTimeout = Math.max(1000, Math.min(response.longpolling_timeout_ms, 120_000));
        }
        // Persist the entire batch and cursor together before emitting anything.
        await store.write('sync', sync);
        await drain();
        if (!watch || count >= maxMessages) break;
        await pause(pollIntervalMs, signal);
      } while (!signal?.aborted);
    } catch (error) {
      if (error.code !== 'CANCELLED') throw error;
    } finally {
      try { await client.notify(false); } catch (error) { await onWarning(error); }
    }
    return { event: signal?.aborted ? 'stopped' : 'poll_complete', count };
  });
}

export async function contacts(store) {
  await store.account();
  return { contacts: Object.values((await store.sync()).contacts).map(({ context_token, ...contact }) => contact) };
}

export async function inbox(store, limit = 20) {
  await store.account();
  return { messages: (await store.sync()).history.slice(-limit).map(publicMessage) };
}

export async function logout(store) {
  return store.lock('receive', async () => {
    for (const name of ['account', 'login', 'sync']) await store.remove(name);
    return { event: 'logged_out', profile: store.profile, scope: 'local' };
  });
}
