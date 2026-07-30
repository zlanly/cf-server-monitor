/**
 * 浏览器端 SSH 客户端（已废弃）
 *
 * 原实现包含完整的 SSH2 协议（DH 密钥交换、AES-CTR、HMAC-SHA2-256、密码认证），
 * 但存在严重 bug（exchange hash 错误、MAC 密钥混乱、CTR counter 不递增等），
 * 实际无法连接任何标准 SSH 服务器。
 *
 * 新架构：Agent 端使用 ssh2 库完成 SSH 握手和 PTY，
 * 浏览器只做 xterm.js 终端 UI + WebSocket 纯透传。
 * 见 SSHTerminal.vue。
 *
 * 此文件保留为空壳，不再被任何模块引用。
 */
