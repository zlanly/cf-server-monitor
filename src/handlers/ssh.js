/**
 * SSH WebSocket 代理（旧版，已废弃）
 *
 * 此模块原使用 Cloudflare Workers TCP connect() 直接代理 SSH，
 * 需要浏览器端实现完整 SSH 协议（加密/解密/认证），存在严重 bug。
 *
 * 新架构使用 Agent 反向隧道 + ssh2 库，见 ssh-agent.js。
 * 路由 /api/ssh 已从 index.js 移除。
 *
 * 保留此文件仅用于参考，不注册任何路由。
 */

export async function handleSSHWebSocketUpgrade() {
  return new Response('SSH direct proxy deprecated. Use Agent tunnel via /api/ssh-agent.', {
    status: 410,
    headers: { 'Content-Type': 'text/plain' }
  });
}
