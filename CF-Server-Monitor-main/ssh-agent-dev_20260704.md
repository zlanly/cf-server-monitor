# SSH Agent 反向隧道实现

**时间**：2026-07-04

## 架构
```
浏览器 (SSH协议) ──WS──▶ Worker (/api/ssh-agent) ──WS──▶ Agent ──TCP──▶ localhost:22
                          ▲ 中继配对                   ▲ 出站连接
                                                      不依赖公网IP
```

## 修改文件（8个）

### 新增（2个）
| 文件 | 大小 | 说明 |
|------|------|------|
| `src/handlers/ssh-agent.js` | 161行 | Worker 中继：agent 连接池 + 浏览器配对 + TCP 重置通知 |
| `agent/ssh-agent.js` | 125行 | 目标服务器 Agent：连 Worker WebSocket → 按需开 TCP → 双向转发，断线自动重连 |

### 修改（6个）
| 文件 | 变更 |
|------|------|
| `src/index.js` | 新增 `/api/ssh-agent` 路由 + Turnstile 白名单 |
| `src/database/schema.js` | servers 表加 `agent_id` 字段 |
| `src/database/updateDatabase.js` | 迁移脚本加 `agent_id` |
| `src/handlers/admin.js` | ADD/EDIT 加 `agent_id` + 补充 INSERT 缺失的 SSH 字段 |
| `src/frontend/views/SSHTerminal.vue` | 改连 `/api/ssh-agent?type=terminal&server_id=X`；从 admin API 加载 SSH 配置；增加连接表单 |

## 使用方式

### 1. 部署 Worker
```bash
wrangler deploy
# 设置环境变量: AGENT_SECRET=你的密钥
```

### 2. 在目标服务器运行 Agent
```bash
npm install ws
node agent/ssh-agent.js my-server-id <AGENT_SECRET> wss://你的项目.workers.dev
```

### 3. 管理后台
编辑服务器 → 设置 `agent_id` 为 `my-server-id`

### 4. 浏览器
服务器详情页 → 点击 SSH → 输入凭证 → Connect

## 数据流
```
浏览器的 SSH 协议字节流
  → WS (/api/ssh-agent?type=terminal)
  → Worker 配对（agent_id 匹配）
  → Agent WS
  → Agent TCP (localhost:22)
  → 目标 SSH Server
```

Agent 首次收到浏览器数据时自动建立 TCP。Worker 在浏览器会话切换时发送 `{"t":"r"}` 通知 Agent 重置 TCP。
