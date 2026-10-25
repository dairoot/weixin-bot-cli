import { parseArgs } from 'node:util';
import { readFile, cp, mkdir, access, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline/promises';
import { Store } from './store.js';
import { BotError, VERSION } from './client.js';
import { login, status, sendText, receive, contacts, inbox, logout } from './bot.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const help = `weixin-bot ${VERSION} — 微信 Bot CLI

用法：weixin-bot <命令> [选项]

  login                  扫码登录，保存凭证；再次调用可继续未完成的登录
    --no-wait            输出二维码后退出，稍后调用 login 继续
    --force              重新获取二维码
    --verify-code CODE   提交手机微信显示的验证码
    --timeout SECONDS    最长等待时间，默认 480 秒
    --base-url URL       登录 API 地址（默认微信 iLink）
  status                 查看本地登录状态，不验证服务端会话
  send --to USER_ID      发送文本消息
    --text TEXT          文本内容（与 --file、--stdin 三选一）
    --file PATH          读取 UTF-8 文本文件；不是发送附件
    --stdin              从标准输入读取文本
    --context-token TOKEN  覆盖缓存的会话令牌
    --allow-without-context  尝试无上下文发送，服务端可能拒绝
    --client-id ID       指定消息请求 ID；发送失败不会自动重试
  receive                长轮询一次，逐条输出 NDJSON 消息
    --once               轮询一次（默认）
    --watch              持续监听，Ctrl+C 停止
    --timeout SECONDS    长轮询超时，默认 35 秒（随后遵循服务端建议）
    --max-messages N     输出 N 条后退出；同批剩余消息保存在本地
  contacts               查看已接收过消息且可回复的用户 ID
  inbox [--limit N]      查看本地最近消息，默认 20 条，最多 1000 条
  logout                 清除当前 profile 的本地凭证、缓存和消息
  skill install [--dir PATH]  安装独立可运行的 skill，默认 ~/.agents/skills/weixin-bot

通用选项：
  --profile NAME         独立账号配置，默认 default
  --state-dir PATH       数据目录，默认 ~/.weixin-bot 或 WEIXIN_BOT_STATE_DIR
  --json                 仅输出结构化事件；登录时不渲染终端二维码
  --help, -h             帮助
  --version, -v          版本

所有结果均为 JSON/NDJSON，诊断和终端二维码写入 stderr。
receive 输出 event=message；结束时输出 poll_complete 或 stopped。
登录需要验证码时返回 verification_required，退出码为 2。
`;

const strings = ['profile', 'state-dir', 'verify-code', 'timeout', 'base-url', 'to', 'text', 'file', 'context-token', 'client-id', 'max-messages', 'limit', 'dir'];
const booleans = ['json', 'no-wait', 'force', 'stdin', 'allow-without-context', 'once', 'watch'];
const commandOptions = {
  login: ['no-wait', 'force', 'verify-code', 'timeout', 'base-url'],
  status: [], send: ['to', 'text', 'file', 'stdin', 'context-token', 'allow-without-context', 'client-id'],
  receive: ['once', 'watch', 'timeout', 'max-messages'], contacts: [], inbox: ['limit'], logout: [], skill: ['dir'],
};

function positive(value, fallback, max = 86400) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) {
    throw new BotError('INVALID_ARGUMENT', `数量或时间必须为 1–${max} 的整数。`);
  }
  return Number(value);
}

async function emit(value) {
  await new Promise((resolveWrite, reject) => {
    process.stdout.write(`${JSON.stringify(value)}\n`, error => error ? reject(error) : resolveWrite());
  });
}

async function installSkill(target) {
  let source = join(root, 'skills', 'weixin-bot');
  try { await access(join(source, 'SKILL.md')); }
  catch { source = dirname(root); } // Also works from an already-installed runtime.
  const dest = resolve(target || join(homedir(), '.agents', 'skills', 'weixin-bot'));
  try {
    await access(dest);
    throw new BotError('ALREADY_EXISTS', `目标目录已存在，未覆盖：${dest}。可使用 --dir 安装到新目录。`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Resolve every source before writing so an incomplete package cannot look installed.
  await access(join(source, 'SKILL.md'));
  const require = createRequire(import.meta.url);
  const qrRoot = dirname(require.resolve('qrcode-terminal/package.json'));
  for (const copiedDir of [join(root, 'src'), join(root, 'bin'), source, qrRoot]) {
    if (dest === copiedDir || dest.startsWith(`${copiedDir}${sep}`)) {
      throw new BotError('INVALID_ARGUMENT', '安装目录不能位于要复制的源码或 skill 目录内部。');
    }
  }
  await mkdir(dirname(dest), { recursive: true });
  await mkdir(dest);
  try {
    await cp(join(source, 'SKILL.md'), join(dest, 'SKILL.md'));
    await cp(join(source, 'scripts'), join(dest, 'scripts'), { recursive: true });
    const runtime = join(dest, 'runtime');
    await mkdir(runtime);
    for (const name of ['src', 'bin', 'package.json', 'LICENSE', 'NOTICE']) {
      await cp(join(root, name), join(runtime, name), { recursive: true });
    }
    await cp(qrRoot, join(runtime, 'node_modules', 'qrcode-terminal'), { recursive: true });
  } catch (error) {
    // Only remove the new directory we exclusively created above.
    await rm(dest, { recursive: true, force: true });
    throw error;
  }
  return { event: 'skill_installed', path: dest, launcher: join(dest, 'scripts', 'weixin-bot.mjs') };
}

export async function main(args = process.argv.slice(2)) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  // Keep EPIPE catchable so a closed pipe leaves the unacknowledged message queued.
  const stdoutError = error => { if (error.code === 'EPIPE') controller.abort(); };
  process.stdout.on('error', stdoutError);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    const { values: v, positionals } = parseArgs({ args, allowPositionals: true, strict: true,
      options: { ...Object.fromEntries(strings.map(name => [name, { type: 'string' }])),
        ...Object.fromEntries(booleans.map(name => [name, { type: 'boolean' }])),
        help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' } } });
    if (v.version) { process.stdout.write(`${VERSION}\n`); return; }
    if (v.help || !positionals.length || positionals[0] === 'help') { process.stdout.write(help); return; }
    const [command, action, ...rest] = positionals;
    if (!Object.hasOwn(commandOptions, command) || rest.length || (action && command !== 'skill') || (command === 'skill' && action !== 'install')) {
      throw new BotError('INVALID_ARGUMENT', '命令无效，请运行 weixin-bot --help。');
    }
    const allowed = new Set(['profile', 'state-dir', 'json', ...commandOptions[command]]);
    for (const key of Object.keys(v)) if (!allowed.has(key)) throw new BotError('INVALID_ARGUMENT', `${command} 不支持 --${key}。`);
    const store = new Store({ profile: v.profile, stateDir: v['state-dir'] });
    const common = { signal: controller.signal, routeTag: process.env.WEIXIN_BOT_ROUTE_TAG };
    let result;
    switch (command) {
      case 'login': {
        if (v['no-wait'] && v['verify-code']) throw new BotError('INVALID_ARGUMENT', '--no-wait 不能与 --verify-code 同时使用。');
        let lastEvent;
        result = await login(store, { ...common, baseUrl: v['base-url'], force: v.force,
          noWait: v['no-wait'], verifyCode: v['verify-code'], timeoutMs: positive(v.timeout, 480) * 1000,
          onEvent: async event => {
            if (event.event === 'scanned' && lastEvent === 'scanned') return;
            lastEvent = event.event;
            await emit(event);
            if (event.event === 'qrcode' && !v.json) {
              try {
                const { default: qr } = await import('qrcode-terminal');
                qr.generate(event.qrcode_url, { small: true }, art => process.stderr.write(`${art}\n`));
              } catch { /* The URL event remains usable without terminal rendering. */ }
              process.stderr.write('请用手机微信扫描二维码并确认。\n');
            }
          },
          readCode: process.stdin.isTTY && !v.json ? async ({ timeoutMs, signal }) => {
            const rl = createInterface({ input: process.stdin, output: process.stderr });
            const deadline = AbortSignal.timeout(timeoutMs);
            try { return await rl.question('输入手机微信显示的数字：', { signal: AbortSignal.any([signal, deadline]) }); }
            catch { throw new BotError(signal.aborted ? 'CANCELLED' : 'LOGIN_TIMEOUT', '验证码输入已取消或超时。'); }
            finally { rl.close(); }
          } : undefined,
        });
        if (result.event === 'verification_required') process.exitCode = 2;
        break;
      }
      case 'status': result = await status(store); break;
      case 'send': {
        const sources = [v.text !== undefined, v.file !== undefined, Boolean(v.stdin)].filter(Boolean).length;
        if (sources !== 1) throw new BotError('INVALID_ARGUMENT', '请提供 --text、--file、--stdin 中的一项。');
        let text = v.text;
        if (v.file) text = await readFile(resolve(v.file), 'utf8');
        if (v.stdin) {
          if (process.stdin.isTTY) throw new BotError('INVALID_ARGUMENT', '--stdin 需要管道或输入重定向。');
          text = '';
          process.stdin.setEncoding('utf8');
          for await (const chunk of process.stdin) text += chunk;
        }
        result = await sendText(store, { ...common, to: v.to, text,
          contextToken: v['context-token'], allowWithoutContext: v['allow-without-context'], clientId: v['client-id'] });
        break;
      }
      case 'receive':
        if (v.once && v.watch) throw new BotError('INVALID_ARGUMENT', '--once 与 --watch 不能同时使用。');
        result = await receive(store, { ...common, watch: v.watch,
          timeoutMs: positive(v.timeout, 35, 120) * 1000,
          maxMessages: positive(v['max-messages'], Infinity, 1_000_000), onMessage: emit,
          onWarning: async error => process.stderr.write(`${JSON.stringify({ warning: error.code || 'ERROR', message: error.message })}\n`),
        });
        break;
      case 'contacts': result = await contacts(store); break;
      case 'inbox': result = await inbox(store, positive(v.limit, 20, 1000)); break;
      case 'logout': result = await logout(store); break;
      case 'skill': result = await installSkill(v.dir); break;
    }
    await emit(result);
  } catch (error) {
    if (error.code === 'EPIPE') { process.exitCode = 0; return; }
    const cancelled = error.code === 'CANCELLED';
    const code = error.code || 'ERROR';
    const message = error instanceof BotError || code.startsWith('ERR_PARSE_ARGS')
      ? error.message : `操作失败（${code}），请检查文件路径、权限或安装状态。`;
    process.stderr.write(`${JSON.stringify({ error: { code, message } })}\n`);
    process.exitCode = cancelled ? 130 : 1;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    process.stdout.removeListener('error', stdoutError);
  }
}
