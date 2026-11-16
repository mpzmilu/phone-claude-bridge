# 手机 Claude 桥 · Phone Claude Bridge

> 用手机钉钉给电脑上的 Claude Code 发消息，让它在本地读代码、改文件、跑命令，结果回到手机。
>
> Chat with Claude Code running on your own Windows machine, from DingTalk on your phone. No desktop UI, no port forwarding, no public IP.

---

## 为什么做这个

笔记本上的 Claude Code 很好用，但人不在电脑前就用不了。常见方案各有门槛：

- **远程桌面**：Windows 家庭版没有 RDP 服务端；而且远程桌面一断开，桌面会话就锁住了。
- **内网穿透 / 端口映射**：要公网 IP 或第三方服务，把本机暴露到公网，风险大。
- **官方 Remote Control**：需要账号支持，部分部署环境下不可用。

这个项目换了个思路：**不操作桌面，直接调命令行版 Claude**。

Claude Code 本来就是无头的（`claude -p "问题"` 就能出答案），真正缺的只是一条能把问题送到电脑、把答案送回手机的通道。

通道选的是**钉钉 Stream 长连接**：由电脑主动连出去，不需要公网 IP、不需要配回调地址、不需要在防火墙上开端口。

---

## 特性

- **锁屏、黑屏都能用**：不依赖图形界面，普通后台进程。
- **零入站端口**：长连接由本机发起，外部没有任何入口。
- **完整能力**：默认 `bypassPermissions`，能读代码、改文件、执行命令。
- **多轮上下文**：会话延续，支持 `/clear`、`/compact`。
- **白名单**：按发送人和会话双重限制，第一次发消息的人自动绑定。
- **两档模式**：`full` 能干活，`lite` 纯问答、极省 token。
- **可选网页通道**：局域网内用浏览器聊（默认关闭）。

---

## 工作原理

```
手机钉钉
   │  普通聊天消息
   ▼
钉钉服务端
   │  Stream 长连接（电脑主动连出去）
   ▼
dws CLI（钉钉官方命令行）
   │  NDJSON 事件流
   ▼
server.mjs（本项目，Node）
   │  spawn 子进程
   ▼
claude -p "问题" --output-format json
   │  JSON 结果
   ▼
server.mjs ──► dws chat +messages-send ──► 手机钉钉
```

三个组件：Claude Code CLI（干活）、dws（收发消息）、server.mjs（本项目，串起来）。

---

## 快速开始

### 1. 装两个 CLI

```bash
npm i -g @anthropic-ai/claude-code
npm i -g dingtalk-workspace-cli
```

登录：

```bash
claude          # 进交互界面后输入 /login
dws auth login  # 扫码或设备授权
```

### 2. 拿到代码

```bash
git clone https://github.com/mpzmilu/phone-claude-bridge.git
cd phone-claude-bridge
copy config.example.json config.json
```

### 3. 改配置

编辑 `config.json`，最少改这一项：

```json
"workDir": "D:\\你的项目目录"
```

留空则使用用户主目录。

### 4. 启动

双击 `start.bat`，再双击 `status.bat` 确认：

```
RUNNING  pid=12345  busy=False
DingTalk channel: ON
Web channel: OFF (DingTalk only)
```

### 5. 手机发消息

打开手机钉钉，进**和自己的单聊窗口**，发一句话。

第一次发消息的人会被自动绑定为唯一使用者——所以务必是你自己先发。

---

## 配置

完整字段说明、白名单规则、会话命令、开机自启、睡眠设置、成本参考、故障排查，都在 **[使用文档.md](使用文档.md)**。

几个最常改的：

| 字段 | 说明 |
|---|---|
| `workDir` | Claude 的工作目录 |
| `mode` | `full` 能读代码跑命令；`lite` 纯问答极省 token |
| `timeoutSec` | 单条问题最长等待秒数，默认 600 |
| `dingtalk.allowedSenders` | 按发送人钉钉 ID 白名单，空则首次绑定 |
| `dingtalk.bindFirstSender` | 白名单为空时，是否让第一个发送者自动成为所有者 |

---

## 安全提示

默认配置是 `bypassPermissions`，**不弹任何审批**。这意味着：

> **谁能让你手机里的钉钉发出消息，谁就能操作这台电脑。**

已有的两道闸是 `allowedSenders` 和 `allowedConversations`。请务必确认：

1. 白名单只包含你自己。
2. 网页通道默认关闭；如果要开，**绝不要把端口映射到公网**——令牌就在网址里。
3. 这台电脑上不要放你无法承担被读取或修改的东西。

想收回权限，把 `permissionMode` 改成 `acceptEdits`，或者用 `plan`（只出方案不动手）。

---

## 环境要求

- Windows 10 / 11
- Node.js 18+
- Claude Code CLI 已登录
- 钉钉 CLI（`dingtalk-workspace-cli`）已登录
- 建议安装 Git for Windows（Claude 的 Bash 工具在 Windows 上依赖它）

---

## 已知限制

- **不是离线队列**：钉钉长连接断开期间的消息会丢失，唤醒后不会补推。电脑睡眠期间发的消息收不到，所以要关掉睡眠。
- **单条消息 4000 字符截断**：钉钉的限制。
- **长任务会超时**：翻代码库的问题实测要 5 分钟，`timeoutSec` 默认已放到 600 秒。
- **只在 Windows 上验证过**：核心逻辑是 Node，理论上可移植到 macOS/Linux，但脚本（`.bat`/`.ps1`）和路径处理是 Windows 专用的。

---

## License

MIT
