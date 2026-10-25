import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { BotError } from './client.js';

export class Store {
  constructor({ stateDir = process.env.WEIXIN_BOT_STATE_DIR || join(homedir(), '.weixin-bot'), profile = 'default' } = {}) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(profile)) throw new BotError('INVALID_PROFILE', 'profile 只能使用 1–64 位字母、数字、下划线和短横线。');
    this.profile = profile;
    this.dir = resolve(stateDir, profile);
  }

  async init() { await mkdir(this.dir, { recursive: true, mode: 0o700 }); }

  async read(name, fallback = null) {
    try { return JSON.parse(await readFile(join(this.dir, `${name}.json`), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return fallback;
      throw new BotError('STATE_ERROR', `无法读取 ${name}.json，请检查文件权限或恢复备份。`);
    }
  }

  async write(name, value) {
    await this.init();
    const target = join(this.dir, `${name}.json`);
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      await rename(temp, target);
    } finally { await rm(temp, { force: true }); }
  }

  async remove(name) { await rm(join(this.dir, `${name}.json`), { force: true }); }

  async lock(name, callback) {
    await this.init();
    const path = join(this.dir, `${name}.lock`);
    try { await mkdir(path, { mode: 0o700 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      throw new BotError('BUSY', `此 profile 已有操作占用 ${path}。若进程异常退出，确认其已停止后删除该锁目录再试。`);
    }
    try {
      await writeFile(join(path, 'owner.json'), JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }), { mode: 0o600 });
      return await callback();
    } finally { await rm(path, { recursive: true, force: true }); }
  }

  async account() {
    const value = await this.read('account');
    if (!value?.token || !value?.account_id || !value?.base_url) throw new BotError('NOT_LOGGED_IN', '尚未登录，请运行 weixin-bot login。');
    return value;
  }

  async sync() {
    const value = await this.read('sync', { cursor: '', contacts: {}, pending: [], history: [], seen: [] });
    if (!value || typeof value.cursor !== 'string' || !value.contacts || Array.isArray(value.contacts) ||
        typeof value.contacts !== 'object' || !['pending', 'history', 'seen'].every(key => Array.isArray(value[key]))) {
      throw new BotError('STATE_ERROR', 'sync.json 数据结构损坏，请恢复备份。');
    }
    return value;
  }
}
