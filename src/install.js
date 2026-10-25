import { access, cp, lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BotError } from './client.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exec = promisify(execFile);
const within = (path, parent) => path === parent || path.startsWith(`${parent}${sep}`);
async function exists(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function installSkill(target) {
  let source = join(root, 'skills', 'weixin-bot');
  try { await access(join(source, 'SKILL.md')); }
  catch { source = dirname(root); }
  const dest = resolve(target || join(homedir(), '.agents', 'skills', 'weixin-bot'));
  if (await exists(dest)) throw new BotError('ALREADY_EXISTS', `目标目录已存在，未覆盖：${dest}。可使用 --dir 安装到新目录。`);
  await access(join(source, 'SKILL.md'));
  const require = createRequire(import.meta.url);
  const qrRoot = dirname(require.resolve('qrcode-terminal/package.json'));
  for (const copiedDir of [join(root, 'src'), join(root, 'bin'), source, qrRoot]) {
    if (within(dest, copiedDir)) throw new BotError('INVALID_ARGUMENT', '安装目录不能位于要复制的源码或 skill 目录内部。');
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
    await rm(dest, { recursive: true, force: true });
    throw error;
  }
  return { event: 'skill_installed', path: dest, launcher: join(dest, 'scripts', 'weixin-bot.mjs') };
}

export async function installOneClick({
  skillDir = join(homedir(), '.agents', 'skills', 'weixin-bot'),
  binDir = join(homedir(), '.local', 'bin'),
  backupDir = join(homedir(), '.local', 'share', 'weixin-bot', 'backups'),
  noBin = false,
} = {}, { createLink = symlink } = {}) {
  const target = resolve(skillDir);
  const bin = resolve(binDir);
  const backups = resolve(backupDir);
  if (within(backups, target) || (!noBin && within(bin, target))) {
    throw new BotError('INVALID_ARGUMENT', '备份目录和命令目录不能位于 skill 安装目录内。');
  }
  // The installer never reads or writes ~/.weixin-bot (credentials and messages).
  await mkdir(dirname(target), { recursive: true });
  const lock = `${target}.install.lock`;
  try { await mkdir(lock); }
  catch (error) {
    if (error.code === 'EEXIST') throw new BotError('BUSY', `已有安装正在进行；若进程已退出，请删除遗留锁目录：${lock}`);
    throw error;
  }
  let stage;
  let backup;
  let previousMoved = false;
  let installed = false;
  let binCreated = false;
  const launcher = join(target, 'scripts', 'weixin-bot.mjs');
  const executable = join(bin, 'weixin-bot');
  try {
    const previous = await exists(target);
    if (previous) {
      if (!previous.isDirectory() || previous.isSymbolicLink()) throw new BotError('INSTALL_CONFLICT', `安装目标不是普通目录：${target}`);
      let pkg;
      let skill;
      try {
        pkg = JSON.parse(await readFile(join(target, 'runtime', 'package.json'), 'utf8'));
        skill = await readFile(join(target, 'SKILL.md'), 'utf8');
      } catch { /* Unknown directories are preserved. */ }
      if (pkg?.name !== 'weixin-bot-cli' || !/^name: weixin-bot\r?$/m.test(skill || '')) {
        throw new BotError('INSTALL_CONFLICT', `目标目录不属于 weixin-bot 安装，未覆盖：${target}`);
      }
    }
    let hasBin = false;
    if (!noBin) {
      const current = await exists(executable);
      if (current) {
        hasBin = current.isSymbolicLink() && resolve(bin, await readlink(executable)) === launcher;
        if (!hasBin) throw new BotError('INSTALL_CONFLICT', `命令路径已被其他文件占用，未覆盖：${executable}。可指定 --bin-dir 或 --no-bin。`);
      }
      await mkdir(bin, { recursive: true });
    }
    stage = await mkdtemp(join(dirname(target), '.weixin-bot-install-'));
    const stagedSkill = join(stage, 'skill');
    await installSkill(stagedSkill);
    // Validate the staged runtime before changing an existing installation.
    await exec(process.execPath, [join(stagedSkill, 'scripts', 'weixin-bot.mjs'), '--version'], { timeout: 10_000 });
    if (previous) {
      await mkdir(backups, { recursive: true });
      const backupRoot = await mkdtemp(join(backups, `${new Date().toISOString().replaceAll(':', '-')}-`));
      backup = join(backupRoot, 'weixin-bot');
      await cp(target, backup, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
      await rename(target, join(stage, 'previous'));
      previousMoved = true;
    }
    await rename(stagedSkill, target);
    installed = true;
    if (!noBin && !hasBin) {
      await createLink(launcher, executable);
      binCreated = true;
    }
    // Commit before cleanup: a cleanup failure must never roll back to a partially
    // removed old tree. The complete old installation also exists in backup.
    previousMoved = false;
    return { event: previous ? 'updated' : 'installed', skill_dir: target,
      launcher, ...(noBin ? {} : { executable }), ...(backup ? { backup } : {}) };
  } catch (error) {
    if (binCreated) await rm(executable, { force: true });
    if (installed) await rm(target, { recursive: true, force: true });
    if (previousMoved) {
      try { await rename(join(stage, 'previous'), target); previousMoved = false; }
      catch { throw new BotError('ROLLBACK_FAILED', `安装失败，旧安装保留在 ${join(stage, 'previous')}；备份位于 ${backup}。`); }
    }
    throw error;
  } finally {
    if (stage && !previousMoved) await rm(stage, { recursive: true, force: true }).catch(() => {
      console.error(`安装临时目录未能清理，可稍后删除：${stage}`);
    });
    await rm(lock, { recursive: true, force: true });
  }
}
