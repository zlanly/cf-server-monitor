/**
 * CF-Server-Monitor SSH Agent
 *
 * 在目标服务器上运行，使用 ssh2 库直接建立 SSH 连接。
 * 浏览器 ↔ Worker ↔ Agent 之间为纯透传（无 SSH 协议在浏览器端实现）。
 *
 * 用法:
 *   node ssh-agent.js                     (交互式输入)
 *   node ssh-agent.js <agent_id> <token> <worker_url> [ssh_host] [ssh_port] [ssh_user] [ssh_password]
 *
 * 示例:
 *   node ssh-agent.js my-server-01 abc123 wss://cf-monitor.workers.dev
 *   node ssh-agent.js my-server-01 abc123 wss://cf-monitor.workers.dev 127.0.0.1 22 root mypass
 */

const WebSocket = require('ws');
const { Client } = require('ssh2');

// ── 解析参数 / 交互式输入 ────────────────────────────
const args = process.argv.slice(2);

function prompt(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.once('data', (d) => resolve(d.toString().trim()));
  });
}

async function getConfig() {
  if (args.length >= 3) {
    return {
      agentId: args[0],
      token: args[1],
      workerUrl: args[2].replace(/\/$/, ''),
      sshHost: args[3] || '127.0.0.1',
      sshPort: parseInt(args[4]) || 22,
      sshUser: args[5] || 'root',
      sshPassword: args[6] || '',
    };
  }

  console.log('=== CF-Server-Monitor SSH Agent ===\n');
  const config = {
    agentId: await prompt('Agent ID (对应监控面板的服务器ID): '),
    token: await prompt('Agent Token: '),
    workerUrl: (await prompt('Worker URL (如 wss://xxx.workers.dev): ')).replace(/\/$/, ''),
    sshHost: (await prompt('SSH Host [127.0.0.1]: ')) || '127.0.0.1',
    sshPort: parseInt((await prompt('SSH Port [22]: ')) || '22') || 22,
    sshUser: (await prompt('SSH User [root]: ')) || 'root',
    sshPassword: await prompt('SSH Password: '),
  };
  return config;
}

// ── 主函数 ──────────────────────────────────────────
async function main() {
  const config = await getConfig();
  const wsUrl = `${config.workerUrl}/api/ssh-agent?type=agent&agent_id=${encodeURIComponent(config.agentId)}&token=${encodeURIComponent(config.token)}`;

  console.log(`\n[Agent] Starting...`);
  console.log(`[Agent] Worker: ${config.workerUrl}`);
  console.log(`[Agent] Target: ${config.sshUser}@${config.sshHost}:${config.sshPort}`);
  console.log(`[Agent] Agent ID: ${config.agentId}`);

  connect(wsUrl, config);
}

function connect(wsUrl, config) {
  let ws = new WebSocket(wsUrl);
  let sshConn = null;
  let sshStream = null;
  let reconnectTimer = null;
  let reconnectDelay = 5000;
  let tcpConnecting = false;

  ws.on('open', () => {
    console.log('[Agent] Connected to Worker, waiting for terminal sessions...');
    reconnectDelay = 5000;
  });

  ws.on('message', (data) => {
    // 检测 control message
    let controlMsg = null;
    try {
      const text = Buffer.isBuffer(data)
        ? data.slice(0, 32).toString('utf-8')
        : (typeof data === 'string' ? data.slice(0, 32) : '');
      if (text.startsWith('{"t":')) controlMsg = JSON.parse(text);
    } catch (e) {}

    if (controlMsg && controlMsg.t === 'r') {
      // 重置 SSH 连接
      if (sshStream) { try { sshStream.end(); } catch(e){} sshStream = null; }
      if (sshConn) { try { sshConn.end(); } catch(e){} sshConn = null; }
      console.log('[Agent] Session reset (new browser connected)');
      return;
    }

    // 首次收到浏览器数据 → 建立 SSH 连接
    if (!sshStream && !tcpConnecting) {
      tcpConnecting = true;
      sshConn = new Client();

      sshConn.on('ready', () => {
        console.log(`[Agent] SSH connected → ${config.sshUser}@${config.sshHost}:${config.sshPort}`);
        sshConn.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err, stream) => {
          tcpConnecting = false;
          if (err) {
            console.error('[Agent] SSH shell error:', err.message);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(`\r\n\x1b[31mSSH shell error: ${err.message}\x1b[0m\r\n`);
              ws.close();
            }
            return;
          }
          sshStream = stream;

          // SSH → 浏览器
          stream.on('data', (chunk) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(chunk);
            }
          });

          stream.on('close', () => {
            console.log('[Agent] SSH stream closed');
            sshStream = null;
            if (ws.readyState === WebSocket.OPEN) {
              ws.close();
            }
          });

          stream.stderr.on('data', (chunk) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(chunk);
            }
          });

          // 发送积压的首条数据
          if (data && data.length > 0) {
            stream.write(data);
          }
        });
      });

      sshConn.on('error', (err) => {
        console.error(`[Agent] SSH error: ${err.message}`);
        tcpConnecting = false;
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(`\r\n\x1b[31mSSH error: ${err.message}\x1b[0m\r\n`);
          ws.close();
        }
      });

      sshConn.on('close', () => {
        console.log('[Agent] SSH connection closed');
        sshStream = null;
        sshConn = null;
        tcpConnecting = false;
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
      });

      // 开始连接
      sshConn.connect({
        host: config.sshHost,
        port: config.sshPort,
        username: config.sshUser,
        password: config.sshPassword,
        readyTimeout: 15000,
        algorithms: {
          // 宽松算法列表，兼容老旧 SSH 服务器
          kex: ['diffie-hellman-group14-sha256', 'diffie-hellman-group14-sha1', 'ecdh-sha2-nistp256', 'diffie-hellman-group-exchange-sha256'],
          cipher: ['aes128-ctr', 'aes256-ctr', 'aes128-gcm', 'chacha20-poly1305@openssh.com', 'aes256-cbc', 'aes128-cbc'],
          serverHostKey: ['ssh-rsa', 'rsa-sha2-256', 'rsa-sha2-512', 'ssh-ed25519', 'ssh-dss'],
          hmac: ['hmac-sha2-256', 'hmac-sha1', 'hmac-sha2-512'],
        },
      });
    } else if (sshStream) {
      // SSH 已连接，直接转发
      sshStream.write(data);
    }
    // 如果正在连接中，丢弃数据（浏览器会重发按键）
  });

  ws.on('close', (code, reason) => {
    const reasonStr = reason ? reason.toString() : 'no reason';
    console.log(`[Agent] Worker disconnected: code=${code} reason=${reasonStr}`);

    // 清理 SSH
    if (sshStream) { try { sshStream.end(); } catch(e){} sshStream = null; }
    if (sshConn) { try { sshConn.end(); } catch(e){} sshConn = null; }
    tcpConnecting = false;

    // 自动重连
    console.log(`[Agent] Reconnecting in ${reconnectDelay / 1000}s...`);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, 60000);
      connect(wsUrl, config);
    }, reconnectDelay);
  });

  ws.on('error', (err) => {
    console.error(`[Agent] WebSocket error: ${err.message}`);
    // close 事件会自动触发重连
  });
}

main().catch((e) => {
  console.error('[Agent] Fatal error:', e.message);
  process.exit(1);
});
