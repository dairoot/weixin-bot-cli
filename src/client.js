import { randomBytes } from 'node:crypto';

export const VERSION = '0.1.0';
// Wire metadata follows the reference client; bot_agent identifies this CLI.
export const CHANNEL_VERSION = '2.4.10';
export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';

export class BotError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

export function validateBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new BotError('INVALID_URL', 'API 地址无效。'); }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
      url.username || url.password || url.search || url.hash) {
    throw new BotError('INVALID_URL', 'API 地址必须使用 HTTPS（本地测试可使用 HTTP），且不能包含凭证、查询参数或片段。');
  }
  return url.href.endsWith('/') ? url.href : `${url.href}/`;
}

// Node >=22 supplies the original JSON token to the reviver, preserving uint64 IDs.
export function parseApiJson(text) {
  return JSON.parse(text, (key, value, context) => {
    if (['message_id', 'msg_id', 'svr_id'].includes(key) && typeof value === 'number') {
      return context.source;
    }
    return value;
  });
}

export class Client {
  constructor({ baseUrl = DEFAULT_BASE_URL, token, routeTag, fetchImpl = fetch } = {}) {
    this.baseUrl = validateBaseUrl(baseUrl);
    this.token = token;
    this.routeTag = routeTag;
    this.fetchImpl = fetchImpl;
  }

  async request(endpoint, { body, authenticated = true, timeoutMs = 15_000, signal } = {}) {
    const post = body !== undefined;
    const headers = {
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': String((2 << 16) | (4 << 8) | 10),
      ...(this.routeTag ? { SKRouteTag: this.routeTag } : {}),
    };
    if (post) {
      headers['Content-Type'] = 'application/json';
      headers.AuthorizationType = 'ilink_bot_token';
      headers['X-WECHAT-UIN'] = Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64');
    }
    if (authenticated) {
      if (!this.token) throw new BotError('NOT_LOGGED_IN', '请先运行 weixin-bot login。');
      headers.Authorization = `Bearer ${this.token}`;
      body = { ...body, base_info: { channel_version: CHANNEL_VERSION, bot_agent: `WeixinBotCLI/${VERSION}` } };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      const response = await this.fetchImpl(new URL(endpoint, this.baseUrl), {
        method: post ? 'POST' : 'GET', headers,
        ...(post ? { body: JSON.stringify(body) } : {}),
        signal: combined, redirect: 'error',
      });
      if (!response.ok) {
        const auth = [401, 403].includes(response.status);
        throw new BotError(auth ? 'SESSION_EXPIRED' : 'HTTP_ERROR',
          auth ? '微信登录凭证失效，请重新运行 login --force。' : `微信接口返回 HTTP ${response.status}。`,
          { retryable: response.status === 429 || response.status >= 500 });
      }
      let result;
      try { result = parseApiJson(await response.text()); }
      catch (error) {
        if (combined.aborted) throw error;
        throw new BotError('INVALID_RESPONSE', '微信接口返回了无效 JSON。');
      }
      if (!result || typeof result !== 'object' || Array.isArray(result)) {
        throw new BotError('INVALID_RESPONSE', '微信接口返回了无效数据。');
      }
      const codes = [result.ret, result.errcode].filter(code => code !== undefined && code !== 0);
      if (codes.includes(-14)) throw new BotError('SESSION_EXPIRED', '微信会话已过期，请运行 login --force 重新扫码。');
      if (codes.length) {
        // Do not print arbitrary response bodies: they may echo credentials.
        const code = typeof codes[0] === 'number' ? codes[0] : 'unknown';
        throw new BotError('API_ERROR', `微信接口业务错误（${code}）。`);
      }
      return result;
    } catch (error) {
      if (signal?.aborted) throw new BotError('CANCELLED', '操作已取消。');
      if (controller.signal.aborted) throw new BotError('TIMEOUT', '请求超时。', { retryable: true });
      if (error instanceof BotError) throw error;
      throw new BotError('NETWORK_ERROR', '无法连接微信接口，请检查网络。', { retryable: true });
    } finally { clearTimeout(timer); }
  }

  getQr(tokens, options = {}) {
    return this.request('ilink/bot/get_bot_qrcode?bot_type=3', {
      ...options, authenticated: false, body: { local_token_list: tokens },
    });
  }

  qrStatus(qrcode, verifyCode, options = {}) {
    const query = new URLSearchParams({ qrcode });
    if (verifyCode) query.set('verify_code', verifyCode);
    return this.request(`ilink/bot/get_qrcode_status?${query}`, { ...options, authenticated: false });
  }

  updates(cursor, options = {}) {
    return this.request('ilink/bot/getupdates', { ...options, body: { get_updates_buf: cursor } });
  }

  send(msg, options = {}) {
    return this.request('ilink/bot/sendmessage', { ...options, body: { msg } });
  }

  notify(start, options = {}) {
    return this.request(`ilink/bot/msg/notify${start ? 'start' : 'stop'}`, { ...options, body: {}, timeoutMs: 3000 });
  }
}
