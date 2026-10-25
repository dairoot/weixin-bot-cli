# 微信 Bot CLI + Skill

参考 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin) 2.4.10 的 iLink 协议，将扫码登录、发送文本和接收消息封装为独立 CLI。无需 OpenClaw、Gateway 或模型 API。

环境：Node.js **22.13.0 或更新版本**。运行时只依赖 `qrcode-terminal`，不需要编译。

## 快速开始

在项目目录安装依赖后，可以直接运行：

```bash
npm install
node bin/weixin-bot.js login
```

用手机微信扫描终端二维码并确认。如要求验证码，输入手机上显示的数字。登录凭证会保存到 `~/.weixin-bot/default/account.json`，后续命令自动读取。

让对方在微信里先给 Bot 发一条消息，然后接收消息、查看真实用户 ID，再回复：

```bash
# 长轮询一次，最多等待约 35 秒
node bin/weixin-bot.js receive --once

# 列出收到过消息的可回复用户
node bin/weixin-bot.js contacts

# 将 USER_ID 替换为 contacts.user_id 或消息的 from_user_id
node bin/weixin-bot.js send --to 'USER_ID' --text '你好，我已收到你的消息'

# 持续接收；Ctrl+C 停止
node bin/weixin-bot.js receive --watch
```

需要使用全局短命令时，可在本项目运行 `npm link`，之后以上命令中的 `node bin/weixin-bot.js` 可替换为 `weixin-bot`。不需要全局命令时跳过此步骤。

## 安装为 agent skill

```bash
node bin/weixin-bot.js skill install
```

默认安装到 `~/.agents/skills/weixin-bot`，包含 `SKILL.md`、启动脚本和独立运行时，移动或删除源码仓库后仍可使用。agent 通过 skill 内的脚本调用 CLI，不依赖 `npm link`。重新打开会话或刷新技能列表后，可用自然语言要求登录、发送或接收微信消息。

指定其他 agent 的 skill 目录：

```bash
node bin/weixin-bot.js skill install --dir ~/.codex/skills/weixin-bot
node ~/.agents/skills/weixin-bot/scripts/weixin-bot.mjs status --json
```

安装器不会覆盖已有目录。更新时可先将旧 skill 目录移到备份位置，再重新安装；登录数据仍在 `~/.weixin-bot`。也可直接在仓库内使用 `skills/weixin-bot/scripts/weixin-bot.mjs`。

## 命令和输出

| 命令 | 用途 |
| --- | --- |
| `login` | 扫码登录；继续尚未完成的登录 |
| `login --force` | 重新扫码登录 |
| `login --no-wait --json` | 输出二维码 URL 并保存待完成登录，方便 agent 分步调用 |
| `login --verify-code CODE --json` | 在另一个进程中提交手机显示的验证码 |
| `status` | 查看本地登录状态，不发送网络请求 |
| `send --to ID --text TEXT` | 发送文本，自动附带缓存的会话令牌 |
| `send --to ID --file PATH` | 将 UTF-8 文件内容作为文本发送 |
| `send --to ID --stdin` | 将标准输入作为文本发送 |
| `receive --once` | 接收一批消息，默认行为 |
| `receive --watch` | 持续接收并在网络故障后退避重试 |
| `receive --watch --max-messages 5` | 输出五条后退出，同批剩余消息保存在本地 |
| `contacts` | 查看缓存的可回复用户 ID，不是微信好友通讯录 |
| `inbox --limit 20` | 查看最近收到的本地消息，不重新轮询 |
| `logout` | 删除当前 profile 的本地登录和消息缓存 |
| `skill install [--dir PATH]` | 安装 skill 和运行时 |

所有业务结果写入 stdout，均为 JSON/NDJSON；诊断和终端二维码写入 stderr。`--json` 禁用登录二维码的终端渲染，保留 `qrcode_url` 事件。无消息的轮询正常结束，不是错误。

例如，接收文本后 stdout 为：

```json
{"event":"message","message_id":"1234567890123456789","from_user_id":"USER_ID","message_type":1,"item_list":[{"type":1,"text_item":{"text":"你好"}}],"text":"你好"}
{"event":"poll_complete","count":1}
```

`message_id` 等 64 位 ID 保持字符串，避免精度丢失。消息正文和媒体元数据保留，会话令牌仅存在本地，不出现在上述输出。监听结束输出 `stopped`。接收消息可筛选后交给其他程序：

```bash
node bin/weixin-bot.js receive --watch --json | jq -c 'select(.event == "message")'
printf '%s' '来自管道的消息' | node bin/weixin-bot.js send --to 'USER_ID' --stdin
```

退出码：`0` 成功，`1` 错误，`2` 登录等待验证码，`130` 登录等操作被取消；正常停止监听返回 `0`。

## 多账号与本地存储

```bash
node bin/weixin-bot.js login --profile work
node bin/weixin-bot.js receive --profile work --once
node bin/weixin-bot.js send --profile work --to 'USER_ID' --text '工作账号回复'
```

`--profile` 隔离登录、游标、消息和会话令牌。数据目录可通过 `--state-dir PATH` 或 `WEIXIN_BOT_STATE_DIR` 覆盖；部署需要路由标签时可设置 `WEIXIN_BOT_ROUTE_TAG`。

- 数据目录创建时使用 `0700`，JSON 文件使用 `0600` 和原子替换；凭证保存在本地明文文件中。
- 一次接收的整批消息、回复上下文和游标写入同一文件，然后逐条输出并移出待交付队列。输出中断后剩余消息下次继续处理。
- 接收是至少一次交付：异常退出窗口可能重复输出。服务端重复批次也会进行有限去重；消费者仍应按消息 ID 做幂等处理。
- `inbox` 保留最近 1000 条消息，最近 2000 个消息指纹用于去重，尚未输出的消息不因历史裁剪而丢失。
- 同一 profile 的登录、退出和接收共用锁，发送可以和监听同时进行。不要让 OpenClaw 和此 CLI 同时轮询同一个 Bot。
- 异常杀死进程可能遗留 `receive.lock`。检查该目录中 `owner.json` 的 PID，确认进程已经停止后才删除锁目录；正常 Ctrl+C 会自动清理。

## 边界与故障处理

当前版本发送**文本**；接收文本及图片、语音、文件、视频的原始元数据，有语音转写时一并输出。未实现媒体下载/解密、媒体上传发送、好友搜索或群聊发送。`--file` 是读取文本，不是附件上传。

收件人应来自实际收到的消息。回复会自动带上该用户最近的 `context_token`。没有上下文时默认报 `MISSING_CONTEXT`；让对方先发消息，再 `receive` 即可。也支持显式 `--context-token TOKEN`；`--allow-without-context` 仅用于尝试无上下文发送，不保证服务端接受任意主动推送。

**登录成功不代表已建立可回复的会话。** Skill 发送前会检查目标用户是否出现在 `contacts` 中；缺少上下文时，先让该用户向当前 Bot 发消息并执行 `receive`，不会自行用 `--allow-without-context` 绕过检查。已有缓存的用户无需每次重新发起会话，但令牌可能需要通过新的入站消息刷新。

`event: "sent"` 和返回的 `message_id` 只表示接口接受请求，不是送达回执。首次联调或用户反馈未收到时，应刷新目标用户的会话上下文、在授权范围内发送一次测试回复，并由用户确认收到后再判断收发链路已打通。

`SESSION_EXPIRED`（包括服务端 `-14`、HTTP 401/403）：重新运行 `login --force`。`status` 只检查本地凭证，不会提前检测过期。

**发送不自动重试**。超时可能意味着服务端已接收消息，但响应未到达；先核对送达情况再决定是否重发。`--client-id` 可指定客户端请求 ID，但服务端去重行为不作保证。监听的临时网络错误会自动退避重试，业务错误和失效会话会退出。

`logout` 只清除当前 profile 的本地数据，解绑需在微信端操作。

## 开发与验证

```bash
npm run check
npm test
npm pack --dry-run
```

测试使用本地 HTTP 模拟服务和临时数据目录，不调用真实微信账号、不发送真实消息。覆盖扫码、验证码、重定向、凭证持久化、鉴权头、长轮询、游标恢复、会话令牌、消息 ID 精度、积压消息、并发锁、错误处理和 CLI 端到端流程。真实服务的可用性仍需本人扫码后验证。

协议参考源码：`openclaw-weixin/src/api/api.ts`、`src/auth/login-qr.ts`、`src/messaging/send.ts`、`src/monitor/monitor.ts` 及 `docs/protocol_zh_CN.md`。原项目版权说明见 [NOTICE](NOTICE) 和 [LICENSE](LICENSE)。
