/**
 * SSH Agent 反向隧道中继器（Worker 侧）
 *
 * 新架构：浏览器 ↔ Worker(纯透传) ↔ Agent(ssh2库完成SSH握手+PTY)
 *
 * 两个 WebSocket 角色：
 *   - type=agent:   Agent 注册自身，保持长连接
 *   - type=terminal: 浏览器终端，配对到对应 Agent 后双向透传
 *
 * Worker 不参与 SSH 协议，只做 WebSocket 中继。
 */

import { checkAuth, simpleAuthResponse } from '../middleware/auth.js';

// 全局连接池（Worker 运行期间保持）
let agentPool = globalThis.__sshAgentPool;
if (!agentPool) {
  agentPool = new Map(); // agentId → WebSocket
  globalThis.__sshAgentPool = agentPool;
}

// 浏览器会话映射（agentId → { agentWs, browserWs }）
let sessionMap = globalThis.__sshSessionMap;
if (!sessionMap) {
  sessionMap = new Map();
  globalThis.__sshSessionMap = sessionMap;
}

export async function handleSSHAgentWebSocket(request, env, sys) {
  const url = new URL(request.url);
  const type = url.searchParams.get('type');

  // ── 认证 ─────────────────────────────────────────────
  if (type === 'agent') {
    const agentToken = url.searchParams.get('token');
    const expectedToken = env.AGENT_SECRET || sys?.agent_token || '';
    if (!expectedToken || agentToken !== expectedToken) {
      return new Response('Unauthorized', { status: 401 });
    }
  } else if (type === 'terminal') {
    const isLoggedIn = await checkAuth(request, env, sys);
    if (!isLoggedIn) {
      return simpleAuthResponse();
    }
  } else {
    return new Response('Missing or invalid type parameter', { status: 400 });
  }

  // ── WebSocket 升级 ──────────────────────────────────
  const upgrade = request.headers.get('Upgrade');
  if (upgrade !== 'websocket') {
    return new Response('Expected WebSocket', { status: 426 });
  }

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();

  if (type === 'agent') {
    return handleAgentConnection(server, url);
  } else {
    return await handleTerminalConnection(server, url, env);
  }
}

// ─── Agent 连接管理 ─────────────────────────────────────
function handleAgentConnection(server, url) {
  const agentId = url.searchParams.get('agent_id');

  if (!agentId) {
    server.close(1008, 'Missing agent_id');
    return new Response(null, { status: 101, webSocket: null });
  }

  // 挤掉旧连接
  const existing = agentPool.get(agentId);
  if (existing) {
    try { existing.close(1000, 'Replaced by new agent connection'); } catch (e) {}
  }

  agentPool.set(agentId, server);
  console.log(`[SSH-Agent] Agent "${agentId}" registered`);

  // Agent → 浏览器（纯透传 SSH 输出）
  server.addEventListener('message', (event) => {
    const session = sessionMap.get(agentId);
    if (session && session.browserWs && session.browserWs.readyState === 1) {
      try { session.browserWs.send(event.data); } catch (e) {}
    }
  });

  server.addEventListener('close', () => {
    agentPool.delete(agentId);
    const session = sessionMap.get(agentId);
    if (session) {
      try { session.browserWs.close(1000, 'Agent disconnected'); } catch (e) {}
      sessionMap.delete(agentId);
    }
    console.log(`[SSH-Agent] Agent "${agentId}" disconnected`);
  });

  server.addEventListener('error', (e) => {
    console.error(`[SSH-Agent] Agent "${agentId}" error:`, e.message);
  });

  return new Response(null, { status: 101, webSocket: client });
}

// ─── 终端连接管理 ─────────────────────────────────────
async function handleTerminalConnection(server, url, env) {
  const serverId = url.searchParams.get('server_id');
  if (!serverId) {
    server.close(1008, 'Missing server_id');
    return new Response(null, { status: 101, webSocket: null });
  }

  // 查找该服务器对应的 Agent
  let agentId;
  try {
    const row = await env.DB.prepare(
      'SELECT agent_id FROM servers WHERE id = ?'
    ).bind(serverId).first();
    agentId = row?.agent_id || serverId;
  } catch (e) {
    agentId = serverId;
  }

  const agentWs = agentPool.get(agentId);
  if (!agentWs || agentWs.readyState !== 1) {
    server.close(1011, `Agent "${agentId}" is not connected`);
    return new Response(null, { status: 101, webSocket: null });
  }

  // 重置旧会话
  const oldSession = sessionMap.get(agentId);
  if (oldSession) {
    try {
      oldSession.browserWs.close(1000, 'Session replaced');
      if (agentWs.readyState === 1) {
        agentWs.send(JSON.stringify({ t: 'r' }));
      }
    } catch (e) {}
  }

  sessionMap.set(agentId, { agentWs, browserWs: server });
  console.log(`[SSH-Agent] Terminal paired → server "${serverId}" / agent "${agentId}"`);

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
    sessionMap.delete(agentId);
    console.log(`[SSH-Agent] Terminal disconnected from agent "${agentId}"`);
  });

  server.addEventListener('error', (e) => {
    console.error(`[SSH-Agent] Terminal error for agent "${agentId}":`, e.message);
    sessionMap.delete(agentId);
  });

  return new Response(null, { status: 101, webSocket: client });
}
