import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, parseApiJson, validateBaseUrl } from '../src/client.js';

test('request matches iLink authentication, version and body metadata', async () => {
  let request;
  const client = new Client({ token: 'secret', routeTag: 'route', fetchImpl: async (url, options) => {
    request = { url, ...options };
    return new Response('{"ret":0,"message_id":18446744073709551615}');
  } });
  const response = await client.send({ to_user_id: 'friend' });
  assert.equal(request.url.pathname, '/ilink/bot/sendmessage');
  assert.equal(request.headers.Authorization, 'Bearer secret');
  assert.equal(request.headers.AuthorizationType, 'ilink_bot_token');
  assert.equal(request.headers['iLink-App-Id'], 'bot');
  assert.equal(request.headers['iLink-App-ClientVersion'], '132106');
  assert.match(Buffer.from(request.headers['X-WECHAT-UIN'], 'base64').toString(), /^\d+$/);
  assert.equal(request.headers.SKRouteTag, 'route');
  assert.equal(request.redirect, 'error');
  assert.deepEqual(JSON.parse(request.body).base_info, { channel_version: '2.4.10', bot_agent: 'WeixinBotCLI/0.1.0' });
  assert.equal(response.message_id, '18446744073709551615');
});

test('QR endpoints omit bearer credentials and base_info, encode verification input', async () => {
  const requests = [];
  const client = new Client({ token: 'secret', fetchImpl: async (url, options) => {
    requests.push({ url, ...options });
    return new Response('{}');
  } });
  await client.getQr(['saved-token']);
  await client.qrStatus('a&b', '1+2');
  assert.equal(requests[0].headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(requests[0].body), { local_token_list: ['saved-token'] });
  assert.equal(requests[1].method, 'GET');
  assert.equal(requests[1].headers.AuthorizationType, undefined);
  assert.equal(requests[1].headers['X-WECHAT-UIN'], undefined);
  assert.equal(requests[1].url.searchParams.get('qrcode'), 'a&b');
  assert.equal(requests[1].url.searchParams.get('verify_code'), '1+2');
});

test('lossless IDs preserve JSON string content and ordinary numbers', () => {
  const parsed = parseApiJson('{"message_id":18446744073709551615,"n":42,"items":[{"msg_id":9007199254740993,"ref":{"svr_id":9999999999999999999}}],"text":"\\\"message_id\\\":123"}');
  assert.equal(parsed.message_id, '18446744073709551615');
  assert.equal(parsed.items[0].msg_id, '9007199254740993');
  assert.equal(parsed.items[0].ref.svr_id, '9999999999999999999');
  assert.equal(parsed.n, 42);
  assert.equal(parsed.text, '"message_id":123');
});

test('HTTP and business errors are actionable without exposing response secrets', async () => {
  for (const body of ['{"ret":-14}', '{"ret":0,"errcode":-14}']) {
    const client = new Client({ token: 'secret', fetchImpl: async () => new Response(body) });
    await assert.rejects(client.updates(''), { code: 'SESSION_EXPIRED' });
  }
  for (const [status, code, retryable] of [[401, 'SESSION_EXPIRED', false], [403, 'SESSION_EXPIRED', false], [429, 'HTTP_ERROR', true], [503, 'HTTP_ERROR', true]]) {
    const client = new Client({ token: 'secret', fetchImpl: async () => new Response('echoed-secret', { status }) });
    await assert.rejects(client.updates(''), error => error.code === code && error.retryable === retryable && !error.message.includes('secret'));
  }
  const client = new Client({ token: 'secret', fetchImpl: async () => new Response('{"ret":123,"errmsg":"secret"}') });
  await assert.rejects(client.send({}), error => error.code === 'API_ERROR' && !error.message.includes('secret'));
});

test('invalid JSON and unsafe endpoints fail closed', async () => {
  for (const body of ['bad', 'null', '[]']) {
    const client = new Client({ token: 'secret', fetchImpl: async () => new Response(body) });
    await assert.rejects(client.updates(''), { code: 'INVALID_RESPONSE' });
  }
  for (const url of ['http://example.com', 'https://user:password@example.com', 'file:///tmp/a', 'https://example.com/?token=x']) {
    assert.throws(() => validateBaseUrl(url), { code: 'INVALID_URL' });
  }
  assert.equal(validateBaseUrl('http://127.0.0.1:1234'), 'http://127.0.0.1:1234/');
});

test('timeout covers body reads and external cancellation remains distinct', async () => {
  const client = new Client({ token: 'secret', fetchImpl: async (_url, { signal }) => ({ ok: true,
    text: () => new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  }) });
  await assert.rejects(client.updates('', { timeoutMs: 10 }), { code: 'TIMEOUT' });
  await assert.rejects(client.updates('', { signal: AbortSignal.abort() }), { code: 'CANCELLED' });
});
