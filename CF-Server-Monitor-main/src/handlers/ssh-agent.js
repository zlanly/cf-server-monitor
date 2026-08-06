/**
 * SSH Agent 反向隧道中继器（Worker 侧入口）
 *
 * 职责：鉴权 + 把 WebSocket 升级请求转发给 Durable Object（SSHAgentRelay）。
 * 实际的中继（连接池、Agent↔浏览器透传）在 DO 内完成，见 src/durable/SSHAgentRelay.js。
 *
 * 这样改造有两个好处：
 *   1. DO 实例常驻、跨 Worker isolate 回收仍保留连接池状态，修复「全局连接池不可靠」问题；
 *   2. 顶层 Worker 直出 101+WebSocket 在本地 `wrangler dev --local` 下由 Miniflare 回环代理失败，
 *      改走 DO 后本地也能正常代理（DO 的 WebSocket 由 Miniflare 正常处理）。
 */

import { checkAuthOrQuery, simpleAuthResponse } from '../middleware/auth.js';

export async function handleSSHAgentWebSocket(request, env, sys) {
  const url = new URL(request.url);
  const type = url.searchParams.get('type');

  // ── 鉴权（中继本身无状态，鉴权在 Worker 入口完成）─────────────
  if (type === 'agent') {
    const agentToken = url.searchParams.get('token');
    const expectedToken = env.AGENT_SECRET || sys?.agent_token || '';
    if (!expectedToken || agentToken !== expectedToken) {
      return new Response('Unauthorized', { status: 401 });
    }
  } else if (type === 'terminal') {
    // 浏览器 WS 升级无法带 Authorization 头，JWT 在 ?token= 上 → 用 checkAuthOrQuery
    const isLoggedIn = await checkAuthOrQuery(request, env, sys);
    if (!isLoggedIn) {
      return simpleAuthResponse();
    }
  } else {
    return new Response('Missing or invalid type parameter', { status: 400 });
  }

  // ── 转发到 Durable Object（DO 内部做 WebSocket 中继）──────────
  try {
    const id = env.SSH_RELAY.idFromName('global');
    const stub = env.SSH_RELAY.get(id);
    return await stub.fetch('http://internal/ssh-relay' + url.search, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: request.redirect
    });
  } catch (e) {
    console.error('[ssh-agent] forward to DO failed:', e.message || e);
    return new Response('Relay unavailable', { status: 503 });
  }
}
