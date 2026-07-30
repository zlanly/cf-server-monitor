/**
 * SSH Agent 反向隧道中继器（Durable Object 版）
 *
 * 新架构：浏览器 ↔ Worker(鉴权+转发) ↔ Durable Object(纯透传) ↔ Agent(ssh2 完成 SSH 握手+PTY)
 *
 * 把连接池从 Worker 全局变量（globalThis.__sshAgentPool）搬进 DO 实例：
 *   1. DO 实例常驻、跨 Worker isolate 回收仍保留状态，解决「Worker 全局连接池不可靠」问题；
 *   2. DO 的 WebSocket 由 Miniflare 本地回环正常代理，修复 `wrangler dev --local` 下
 *      顶层 Worker 直出 101+WebSocket 时返回 500 的限制。
 *
 * 转发约定：Worker 侧鉴权通过后，把原始请求（含 type/agent_id/token/server_id 查询参数）
 * 转发到 http://internal/ssh-relay?<query>。本 DO 仅做透传中继，不再重复鉴权。
 */

export class SSHAgentRelay {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // 全局连接池（DO 实例内常驻）
    this.agentPool = new Map();      // agentId -> WebSocket
    this.sessionMap = new Map();     // agentId -> { agentWs, browserWs }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const type = url.searchParams.get('type');

    // ── WebSocket 升级 ──────────────────────────────
    const upgrade = request.headers.get('Upgrade');
    if (upgrade !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    if (type === 'agent') {
      return this.handleAgentConnection(server, url, client);
    } else if (type === 'terminal') {
      return await this.handleTerminalConnection(server, url, client);
    } else {
      server.close(1008, 'Missing or invalid type parameter');
      return new Response(null, { status: 101, webSocket: client });
    }
  }

  // ─── Agent 连接管理 ─────────────────────────────────
  handleAgentConnection(server, url, client) {
    const agentId = url.searchParams.get('agent_id');

    if (!agentId) {
      server.close(1008, 'Missing agent_id');
      return new Response(null, { status: 101, webSocket: client });
    }

    // 挤掉旧连接
    const existing = this.agentPool.get(agentId);
    if (existing) {
      try { existing.close(1000, 'Replaced by new agent connection'); } catch (e) {}
    }

    this.agentPool.set(agentId, server);
    console.log(`[SSH-Agent] Agent "${agentId}" registered (via DO)`);

    // Agent → 浏览器（纯透传 SSH 输出）
    server.addEventListener('message', (event) => {
      const session = this.sessionMap.get(agentId);
      if (session && session.browserWs && session.browserWs.readyState === 1) {
        try { session.browserWs.send(event.data); } catch (e) {}
      }
    });

    server.addEventListener('close', () => {
      this.agentPool.delete(agentId);
      const session = this.sessionMap.get(agentId);
      if (session) {
        try { session.browserWs.close(1000, 'Agent disconnected'); } catch (e) {}
        this.sessionMap.delete(agentId);
      }
      console.log(`[SSH-Agent] Agent "${agentId}" disconnected (via DO)`);
    });

    server.addEventListener('error', (e) => {
      console.error(`[SSH-Agent] Agent "${agentId}" error:`, e.message);
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  // ─── 终端连接管理 ─────────────────────────────────
  async handleTerminalConnection(server, url, client) {
    const serverId = url.searchParams.get('server_id');
    if (!serverId) {
      server.close(1008, 'Missing server_id');
      return new Response(null, { status: 101, webSocket: client });
    }

    // 查找该服务器对应的 Agent
    let agentId;
    try {
      const row = await this.env.DB.prepare(
        'SELECT agent_id FROM servers WHERE id = ?'
      ).bind(serverId).first();
      agentId = row?.agent_id || serverId;
    } catch (e) {
      agentId = serverId;
    }

    const agentWs = this.agentPool.get(agentId);
    if (!agentWs || agentWs.readyState !== 1) {
      server.close(1011, `Agent "${agentId}" is not connected`);
      return new Response(null, { status: 101, webSocket: client });
    }

    // 重置旧会话
    const oldSession = this.sessionMap.get(agentId);
    if (oldSession) {
      try {
        oldSession.browserWs.close(1000, 'Session replaced');
        if (agentWs.readyState === 1) {
          agentWs.send(JSON.stringify({ t: 'r' }));
        }
      } catch (e) {}
    }

    this.sessionMap.set(agentId, { agentWs, browserWs: server });
    console.log(`[SSH-Agent] Terminal paired -> server "${serverId}" / agent "${agentId}" (via DO)`);

    // 浏览器 → Agent（纯透传按键）
    server.addEventListener('message', (event) => {
      if (agentWs.readyState === 1) {
        try { agentWs.send(event.data); } catch (e) {}
      }
    });

    server.addEventListener('close', () => {
      // 通知 Agent 重置 SSH 连接
      if (agentWs.readyState === 1) {
        try { agentWs.send(JSON.stringify({ t: 'r' })); } catch (e) {}
      }
      this.sessionMap.delete(agentId);
      console.log(`[SSH-Agent] Terminal disconnected from agent "${agentId}" (via DO)`);
    });

    server.addEventListener('error', (e) => {
      console.error(`[SSH-Agent] Terminal error for agent "${agentId}":`, e.message);
      this.sessionMap.delete(agentId);
    });

    return new Response(null, { status: 101, webSocket: client });
  }
}
