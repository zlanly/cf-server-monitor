# CF-Server-Monitor 代码审查报告

**审查时间**: 2026-07-05  
**审查范围**: 全项目（src/, agent/, 46个文件）

---

## 严重问题（5个）

### 🔴 1. SSH Exchange Hash 严重简化，大部分 SSH 服务器会拒绝连接

**文件**: `src/frontend/utils/ssh-client.js` → `_handleKexDhReply()`

Exchange Hash H 是 SSH 握手的核心安全组件，当前实现完全错误：

```js
// 当前代码 - 完全不正确
const hashInput = concat(
  new TextEncoder().encode('CF-Server-Monitor'), // V_C 错误
  new TextEncoder().encode('SSH-2.0-server'),    // V_S 错误
  hostKeyBlob,                                   // 缺少 I_C, I_S, e, f
  sharedSecretBytes,
);
```

**正确实现需要**：
- `V_C` / `V_S`: 客户端/服务器的 SSH 版本标识字符串（含 `\r\n`）
- `I_C` / `I_S`: 客户端/服务器的完整 KEXINIT 消息载荷（从消息类型字节开始）
- `K_S`: 服务器主机公钥 blob
- `e`: 客户端 DH 公钥
- `f`: 服务器 DH 公钥
- `K`: 共享密钥

所有字段按 SSH string 格式（4字节长度前缀 + 数据）拼接，然后 SHA-256。

**影响**: 密钥派生结果不正确，加密/解密/MAC 全部失效，SSH 握手必然失败。这个 SSH 客户端实际上无法连接任何标准 SSH 服务器。

**修复**: 需要重写 `_handleKexDhReply`，记录完整的握手消息（客户端版本、服务器版本、客户端 KEXINIT 原始包、服务器 KEXINIT 原始包），按 RFC 4253 §8 构造 exchange hash。

---

### 🔴 2. SSH MAC 密钥使用错误

**文件**: `src/frontend/utils/ssh-client.js` → `_ingestData()` 和 `_computeMAC()`

解密时验证 MAC 使用的密钥不一致：

```js
// _ingestData 中调用：
const expectedMAC = await this._computeMAC(
  this.decryptMACKeyRaw || this.encryptMACKeyRaw,  // ← 问题：回退到 encrypt key
  encryptedData, this.decryptSeq);
```

```js
// _computeMAC 中：
this._macKeyObj = await crypto.subtle.importKey(
  'raw', keyRaw,
  { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
```

**问题**：
1. `this.decryptMACKeyRaw` 在 `_deriveKeys` 中已赋值，不应回退到 `encryptMACKeyRaw`
2. `_macKeyObj` 在 `_deriveKeys` 中用 `encryptMACKeyRaw` 导入，但解密验证时又传入 `decryptMACKeyRaw`，导致第一次解密验证时 `_macKeyObj` 已经绑定了错误的密钥
3. `_macKeyObj` 是单例缓存，无法同时服务加密和解密两个不同密钥

**修复**: 需要两个独立的 CryptoKey 对象：`_macKeyEncrypt` 和 `_macKeyDecrypt`。

---

### 🔴 3. SSH AES-CTR counter 实现错误

**文件**: `src/frontend/utils/ssh-client.js` → `_aesCtrBlock()`

```js
async _aesCtrBlock(data, iv, seqNum, encrypt) {
  const counter = new Uint8Array(16);
  counter.set(iv);
  const dv = new DataView(counter.buffer);
  dv.setBigUint64(8, BigInt(seqNum), false);  // ← 问题
```

SSH AES-CTR 模式（RFC 4344）的 counter 是 `IV || seq`，但不是简单地把 seq 写入后 8 字节。SSH-CTR 的 counter 是一个 16 字节整数，初始值为 `IV`，每次加密一个块后 counter 递增 1。

当前实现把 `seqNum` 直接写入 counter 的后 8 字节，这意味着每个包的 counter 都从 IV 重新开始计算，而不是在包内递增。一个 SSH 包通常有多个块（每个 16 字节），第 2 个块及之后的 counter 都不递增，导致相同的明文块加密成相同的密文块。

**修复**: 需要正确实现 CTR 模式：counter 初始为 IV，每个 16 字节块加密后 counter 递增 1。使用 `crypto.subtle` 的 AES-CTR 需要一次性传入整包数据（而非逐块），让 SubtleCrypto 自己处理 counter 递增。

---

### 🔴 4. ssh.js (旧 SSH 代理) 与 ssh-agent.js (新 Agent 隧道) 路由冲突

**文件**: `src/index.js`

```js
{ method: 'GET', path: '/api/ssh', handler: ... }     // 旧：Worker TCP 直连
{ method: 'GET', path: '/api/ssh-agent', handler: ... } // 新：Agent 反向隧道
```

`ssh.js` 使用 Cloudflare `connect()` 直接 TCP 连接目标服务器，但目标服务器无公网 IP 时不可用。`ssh-agent.js` 是新的 Agent 隧道方案。

**问题**：
- `SSHTerminal.vue` 已改为连 `/api/ssh-agent`，但 `ssh.js` 代码仍然保留
- `bypassTurnstilePaths` 中两个路径都存在
- `ssh.js` 中的 `server.send(JSON.stringify({ type: 'ssh_config', ... }))` 逻辑与 Agent 隧道不兼容（Agent 隧道是透明转发，不会发 JSON 配置消息）
- `ssh-client.js` 的 `connect()` 仍然检查首条消息是否为 JSON 配置（`data[0] === 0x7b`），但 Agent 隧道的第一条消息是 SSH 服务器的版本字符串

**修复**: 
1. 删除 `ssh.js` 或标记为 deprecated
2. 从路由表和 `bypassTurnstilePaths` 中移除 `/api/ssh`
3. 从 `ssh-client.js` 中移除 JSON 配置检查逻辑

---

### 🔴 5. SSH `_handlePacket` 中 CHANNEL_OPEN_CONFIRMATION 逻辑错误

**文件**: `src/frontend/utils/ssh-client.js`

```js
case SSH_MSG_CHANNEL_OPEN_CONFIRMATION:
  const remoteId = reader.readUint32();      // ← 读取的是 recipient_channel
  this.remoteChannel = reader.readUint32();  // ← 读取的是 sender_channel
  this._requestPty();
  break;
```

按 RFC 4254 §5.1，CHANNEL_OPEN_CONFIRMATION 格式：
```
byte      SSH_MSG_CHANNEL_OPEN_CONFIRMATION
uint32    recipient_channel  (本地通道号)
uint32    sender_channel     (远程通道号)
uint32    initial_window_size
uint32    max_packet_size
```

当前代码：
- `remoteId` 读取的是 `recipient_channel`（本地通道号），变量名误导
- `this.remoteChannel` 读取的是 `sender_channel`（远程通道号），值正确但变量赋值逻辑混乱
- 没有读取 `initial_window_size` 和 `max_packet_size`
- `_requestPty()` 在这里直接调用，但此时 NEWKEYS 后的第一个加密包可能还未完全处理

**修复**: 正确解析所有字段，变量命名清晰。

---

## 中等问题（7个）

### 🟡 6. Agent 安装脚本中内嵌的 ssh-agent.js 代码过时

**文件**: `agent/install-agent.sh`, `agent/install-agent.bat`

安装脚本中通过 heredoc 内嵌了一份精简版 ssh-agent.js，但这份代码与 `agent/ssh-agent.js` 主文件不同步（缺少 control message 处理、重连逻辑不一致）。

**修复**: 安装脚本应直接下载或复制 `agent/ssh-agent.js`，而非内嵌独立副本。

---

### 🟡 7. ssh-agent.js (Agent端) 在 TCP 连接建立前就写入数据

**文件**: `agent/ssh-agent.js`

```js
tcpSocket.connect(config.sshPort, config.sshHost, () => {
  console.log(`[Agent] SSH tunnel established`);
  tcpSocket.write(data);  // 在 connect 回调中写入
});
```

如果在 `connect` 回调触发前收到了第二条消息（虽然不太可能），`tcpSocket` 已存在但尚未连接，会直接走到 `else` 分支的 `tcpSocket.write(data)`，此时 TCP 连接尚未建立，write 会失败。

**修复**: 增加连接状态标志 `tcpConnecting`，在连接建立前缓存数据。

---

### 🟡 8. ssh-agent.js (Worker端) 使用全局变量存储连接池

**文件**: `src/handlers/ssh-agent.js`

```js
let agentPool = globalThis.__sshAgentPool;
let sessionMap = globalThis.__sshSessionMap;
```

Cloudflare Workers 的 isolate 可能被回收和重建，全局变量不可靠。如果 Worker 在会话期间被重新初始化，`agentPool` 和 `sessionMap` 会丢失，导致 Agent 连接和浏览器会话失联。

**修复**: 考虑使用 Durable Objects 存储连接状态，或在 Agent 重连时自动恢复。当前方案对于低频使用场景可接受，但需在文档中标注限制。

---

### 🟡 9. SSHTerminal.vue 自动连接时不处理 loadServerConfig 失败

**文件**: `src/frontend/views/SSHTerminal.vue`

```js
async loadServerConfig() {
  try {
    const res = await fetch('/admin/api', ...);
    if (res.ok) {
      // ...
      if (this.hostName && this.userName && this.password) {
        this.connect();
        return;
      }
    }
  } catch (e) {
    console.error('[SSH] Failed to load server config:', e);
  }
  this.formVisible = true;
}
```

如果 `fetch` 失败（网络错误、auth 过期），会显示表单。但如果 auth token 过期，用户看到的表单填了默认值 `root@localhost:22`，连接也会失败。缺少明确的错误提示。

**修复**: 区分网络错误和认证失败，显示对应的错误信息。

---

### 🟡 10. 旧 ssh.js 中 `request.ctx?.waitUntil` 不存在

**文件**: `src/handlers/ssh.js`

```js
if (typeof request.ctx?.waitUntil === 'function') {
  request.ctx.waitUntil(forwardPromise);
}
```

`request` 是一个标准 Request 对象，没有 `.ctx` 属性。`ctx` 是 `fetch(request, env, ctx)` 的第三个参数，但没有传递给 `handleSSHWebSocketUpgrade`。

**修复**: 将 `ctx` 传递进来，或使用 `env` 上的方法。由于此文件应被删除（见问题 4），优先级低。

---

### 🟡 11. SSHTerminal.vue 缺少 loading-spinner 样式

**文件**: `src/frontend/views/SSHTerminal.vue`

模板中使用了 `<div class="loading-spinner"></div>`，但 `<style scoped>` 中没有定义 `.loading-spinner` 样式，所以不会显示任何 spinner 动画。

**修复**: 添加 spinner CSS 或使用已有的 spinner 组件。

---

### 🟡 12. ssh-client.js 中 PTY 请求 `want reply = false` 但代码期望 CHANNEL_SUCCESS

**文件**: `src/frontend/utils/ssh-client.js`

```js
// _requestPty 中：
w.writeBoolean(false); // want reply = false

// _handlePacket 中：
case SSH_MSG_CHANNEL_SUCCESS:
  if (!this._ptyRequested) {
    this._ptyRequested = true;
  } else {
    this._requestShell();
  }
  break;
```

PTY 请求设置了 `want reply = false`，服务器不会回复 `CHANNEL_SUCCESS`。但 `_handlePacket` 中的逻辑依赖 `CHANNEL_SUCCESS` 来推进状态（先 PTY 后 shell）。由于 PTY 不要求回复，shell 请求永远不会被触发。

**修复**: PTY 请求后直接发送 shell 请求（两者都设 `want reply = false`），或者 PTY 设 `want reply = true` 并在收到 SUCCESS 后发 shell。

---

## 轻微问题（4个）

### 🟢 13. Agent 连接 URL 中传递 SSH host/port 不安全

**文件**: `agent/ssh-agent.js`, `src/handlers/ssh-agent.js`

Agent 连接 URL 包含 `host` 和 `port` 参数：
```
/api/ssh-agent?type=agent&agent_id=xxx&token=xxx&host=127.0.0.1&port=22
```

这些参数在 HTTPS 请求中可见（URL 日志、CDN 日志）。虽然 host 通常是 `127.0.0.1`，但如果用户配置了其他地址，会泄露内部网络信息。

**修复**: 将 host/port 配置移到 Agent 本地配置文件，不通过 URL 传递。Worker 端不需要知道 SSH host/port（Agent 自行处理）。

---

### 🟢 14. SSHTerminal.vue disconnect() 直接路由返回，未清理 WebSocket

**文件**: `src/frontend/views/SSHTerminal.vue`

```js
disconnect() {
  this.cleanup();  // 清理 sshClient 和 term
  this.$router.push('/server/' + this.serverId);
}
```

`cleanup()` 调用 `sshClient.disconnect()` 关闭 WebSocket，但没有等待 close 事件确认。如果路由切换过快，可能导致组件卸载后仍有 pending 的 WebSocket 回调。

**影响**: 低概率的内存泄漏或控制台报错。

---

### 🟢 15. install-agent.bat 中 PowerShell 命令编码问题

**文件**: `agent/install-agent.bat`

`.bat` 文件使用 GBK 编码（Windows 默认），但内嵌的 Node.js 脚本使用 UTF-8 字符串。如果系统 locale 不是中文，`echo` 的中文注释可能乱码。

**修复**: 在 .bat 开头加 `chcp 65001 >nul` 切换到 UTF-8 代码页。

---

### 🟢 16. wrangler.toml 缺少 `AGENT_SECRET` 环境变量说明

**文件**: `wrangler.toml`

`[vars]` 部分为空，`AGENT_SECRET` 需要通过 `wrangler secret put AGENT_SECRET` 设置，但文档中未明确说明。

---

## 架构建议

1. **SSH 客户端协议实现不完整**：当前 `ssh-client.js` 的 exchange hash、AES-CTR、MAC 实现都有根本性错误，无法实际工作。建议：
   - **短期**: 使用 `ssh2` 库的 WASM 版本或 `ndssh` 等已验证的浏览器 SSH 库
   - **长期**: 如确需自研，需完整实现 RFC 4253/4344，并 Against OpenSSH 进行测试

2. **旧 ssh.js 应删除**：Agent 隧道方案已取代直连方案，保留旧代码增加混淆

3. **Agent 连接状态持久化**：考虑用 Durable Objects 管理 Agent 连接池，避免 Worker isolate 回收导致状态丢失

4. **SSH 密码明文存储**：D1 中的 `ssh_password` 为明文，建议使用 Worker 的 Secret 或加密存储
