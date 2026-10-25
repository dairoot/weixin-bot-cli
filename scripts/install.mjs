#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { dirname, delimiter } from 'node:path';
import { installOneClick } from '../src/install.js';

try {
  const { values } = parseArgs({ options: {
    'skill-dir': { type: 'string' }, 'bin-dir': { type: 'string' },
    'backup-dir': { type: 'string' }, 'no-bin': { type: 'boolean' },
  } });
  const result = await installOneClick({ skillDir: values['skill-dir'], binDir: values['bin-dir'],
    backupDir: values['backup-dir'], noBin: values['no-bin'] });
  console.log(`微信 Bot ${result.event === 'updated' ? '更新' : '安装'}完成。`);
  console.log(`Skill：${result.skill_dir}`);
  if (result.backup) console.log(`旧版本备份：${result.backup}`);
  if (result.executable) {
    console.log(`CLI：${result.executable}`);
    if (!(process.env.PATH || '').split(delimiter).includes(dirname(result.executable))) {
      console.log('命令目录尚未加入 PATH；可先使用上面的绝对路径执行 login。');
      const quoted = `'${dirname(result.executable).replaceAll("'", "'\\''")}'`;
      console.log(`要使用 weixin-bot 短命令，请将此行加入 shell 配置后重新打开终端：\nexport PATH=${quoted}:"$PATH"`);
    }
  }
  console.log('重新打开 agent 会话即可发现 skill；可要求 agent 登录微信。');
} catch (error) {
  console.error(`安装失败：${error.message}`);
  process.exitCode = 1;
}
