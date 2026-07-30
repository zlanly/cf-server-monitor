# CF-Server-Monitor SSH 功能开发

**时间**：2026-07-04 23:37

## 架构设计

```
浏览器 (xterm.js) --WebSocket--> Worker (/api/ssh) --TCP connect()--> SSH Server:22
                    SSH协议实现(浏览器端)                 透传代理
```

**核心思路**：Worker 不实现 SSH 协议，只做 WebSocket ↔ TCP 透传。SSH 加密/解密/认证全在浏览器端通过 Web Crypto API 完成。

## 修改文件清单（10个文件）

### 新增文件（3个）
| 文件 | 说明 |
|------|------|
| `src/handlers/ssh.js` | Worker SSH 代理：WS升级 → DB查服务器SSH配置 → TCP connect() → 双向透传 |
| `src/frontend/utils/ssh-client.js` | 浏览器端 SSH2 协议实现：DH密钥交换(aes128-ctr+hmac-sha2-256)、密码认证、session/pty/shell |
| `src/frontend/views/SSHTerminal.vue` | SSH 终端页面：xterm.js + FitAddon + WebLinksAddon，TokyoNight 主题 |

### 修改文件（7个）
| 文件 | 变更内容 |
|------|---------|
| `src/index.js` | 新增 `/api/ssh` 路由 + Turnstile白名单 + SSH handler调用 |
| `src/handlers/admin.js` | 服务器增删改支持 ssh_host/ssh_port/ssh_user/ssh_password 四个字段 |
| `src/database/schema.js` | servers 表增加 SSH 字段（CREATE TABLE） |
| `src/database/updateDatabase.js` | addServerColumns 增加 SSH 字段（ALTER TABLE 迁移） |
| `src/frontend/router/index.js` | 新增 `/ssh/:id` 路由 |
| `src/frontend/views/ServerDetail.vue` | 导航栏新增 SSH 按钮（跳转到终端页面）|
| `src/frontend/styles/main.css` | 新增 .ssh-btn-nav 样式 |

### 依赖安装
- `@xterm/xterm` `@xterm/addon-fit` `@xterm/addon-web-links`

## 支持的 SSH 算法

- **KEX**: diffie-hellman-group14-sha256
- **加密**: aes128-ctr（AES-128，CTR模式）
- **MAC**: hmac-sha2-256
- **认证**: password
- **主机密钥**: ssh-rsa, rsa-sha2-256, rsa-sha2-512

## 使用方式

1. 部署到 Cloudflare Workers（`wrangler deploy`）
2. 运行数据库更新：POST `/updateDatabase`（自动添加 SSH 字段）
3. 在管理后台编辑服务器，填写 SSH 连接信息（host/port/user/password）
4. 进入服务器详情页，点击「SSH」按钮
5. 首次连接提示输入密码（存储在 localStorage）

## 已知限制

1. **Worker TCP connect() 必须部署后才能使用**，本地 `wrangler dev` 不支持 TCP socket
2. SSH 密码明文存储在 D1 数据库中（生产环境建议用 Worker Secrets 加密存储）
3. 不支持 SSH 密钥认证，仅支持密码
4. DH 交换中的 exchange hash 构造做了简化（缺少完整 I_C/I_S 字节），部分服务器可能握手失败
5. 10 分钟无操作自动断线

## 后续优化建议

- SSH 密码加密存储（AES-GCM + Worker Secret）
- 支持 ssh-ed25519 密钥认证
- 支持更多 KEX 算法（curve25519-sha256）
- 会话录制/回放
- 多 Tab 终端
