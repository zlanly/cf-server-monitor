#!/bin/bash
# CF-Server-Monitor SSH Agent 一键安装脚本 (Linux)
# 用法: chmod +x install-agent.sh && sudo ./install-agent.sh

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN} CF-Server-Monitor SSH Agent Installer${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""

# ── 读取配置 ──────────────────────────────
read -p "Worker URL (如 wss://cf-monitor.xxx.workers.dev): " WORKER_URL
read -p "Agent ID (对应面板的服务器ID): " AGENT_ID
read -p "Agent Token: " AGENT_TOKEN
read -p "SSH Host [127.0.0.1]: " SSH_HOST
SSH_HOST="${SSH_HOST:-127.0.0.1}"
read -p "SSH Port [22]: " SSH_PORT
SSH_PORT="${SSH_PORT:-22}"
read -p "SSH User [root]: " SSH_USER
SSH_USER="${SSH_USER:-root}"
read -p "SSH Password: " SSH_PASSWORD

# ── 安装 Node.js (如果不存在) ──────────────
if ! command -v node &> /dev/null; then
    echo -e "${YELLOW}[1/4] Installing Node.js...${NC}"
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
else
    echo -e "${GREEN}[1/4] Node.js already installed: $(node -v)${NC}"
fi

# ── 安装依赖 ─────────────────────────────
echo -e "${YELLOW}[2/4] Installing dependencies (ws, ssh2)...${NC}"
AGENT_DIR="/opt/cf-monitor-agent"
mkdir -p "$AGENT_DIR"
cd "$AGENT_DIR"
npm init -y --silent 2>/dev/null
npm install ws ssh2 --save 2>/dev/null

# ── 下载 Agent 脚本 ──────────────────────
echo -e "${YELLOW}[3/4] Configuring agent...${NC}"
cat > ssh-agent.js << 'AGENTEOF'
// CF-Server-Monitor SSH Agent (ssh2 版本)
const WebSocket = require('ws');
const { Client } = require('ssh2');

const AGENT_ID = process.env.AGENT_ID || '';
const AGENT_TOKEN = process.env.AGENT_TOKEN || '';
const WORKER_URL = (process.env.WORKER_URL || '').replace(/\/$/, '');
const SSH_HOST = process.env.SSH_HOST || '127.0.0.1';
const SSH_PORT = parseInt(process.env.SSH_PORT) || 22;
const SSH_USER = process.env.SSH_USER || 'root';
const SSH_PASSWORD = process.env.SSH_PASSWORD || '';

let sshConn = null;
let sshStream = null;
let reconnectDelay = 5000;
let tcpConnecting = false;

function connect() {
  const wsUrl = `${WORKER_URL}/api/ssh-agent?type=agent&agent_id=${encodeURIComponent(AGENT_ID)}&token=${encodeURIComponent(AGENT_TOKEN)}`;
  const ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    console.log(`[${new Date().toISOString()}] Connected to ${WORKER_URL}`);
    reconnectDelay = 5000;
  });

  ws.on('message', (data) => {
    let ctrl = null;
    try {
      const txt = Buffer.isBuffer(data) ? data.slice(0,32).toString() : String(data).slice(0,32);
      if (txt.startsWith('{"t":')) ctrl = JSON.parse(txt);
    } catch(e) {}

    if (ctrl && ctrl.t === 'r') {
      if (sshStream) { try { sshStream.end(); } catch(e){} sshStream = null; }
      if (sshConn) { try { sshConn.end(); } catch(e){} sshConn = null; }
      tcpConnecting = false;
      console.log(`[${new Date().toISOString()}] Session reset`);
      return;
    }

    if (!sshStream && !tcpConnecting) {
      tcpConnecting = true;
      sshConn = new Client();

      sshConn.on('ready', () => {
        console.log(`[${new Date().toISOString()}] SSH → ${SSH_USER}@${SSH_HOST}:${SSH_PORT}`);
        sshConn.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err, stream) => {
          tcpConnecting = false;
          if (err) {
            console.error('Shell error:', err.message);
            if (ws.readyState === 1) { ws.send(`\r\n\x1b[31mShell error: ${err.message}\x1b[0m\r\n`); ws.close(); }
            return;
          }
          sshStream = stream;
          stream.on('data', chunk => { if (ws.readyState === 1) ws.send(chunk); });
          stream.on('close', () => { sshStream = null; if (ws.readyState === 1) ws.close(); });
          stream.stderr.on('data', chunk => { if (ws.readyState === 1) ws.send(chunk); });
          if (data && data.length > 0) stream.write(data);
        });
      });

      sshConn.on('error', e => {
        console.error('SSH error:', e.message);
        tcpConnecting = false;
        if (ws.readyState === 1) { ws.send(`\r\n\x1b[31mSSH error: ${e.message}\x1b[0m\r\n`); ws.close(); }
      });

      sshConn.on('close', () => {
        sshStream = null; sshConn = null; tcpConnecting = false;
        if (ws.readyState === 1) ws.close();
      });

      sshConn.connect({
        host: SSH_HOST, port: SSH_PORT, username: SSH_USER, password: SSH_PASSWORD,
        readyTimeout: 15000,
        algorithms: {
          kex: ['diffie-hellman-group14-sha256','diffie-hellman-group14-sha1','ecdh-sha2-nistp256','diffie-hellman-group-exchange-sha256'],
          cipher: ['aes128-ctr','aes256-ctr','aes128-gcm','chacha20-poly1305@openssh.com','aes256-cbc','aes128-cbc'],
          serverHostKey: ['ssh-rsa','rsa-sha2-256','rsa-sha2-512','ssh-ed25519','ssh-dss'],
          hmac: ['hmac-sha2-256','hmac-sha1','hmac-sha2-512'],
        },
      });
    } else if (sshStream) {
      sshStream.write(data);
    }
  });

  ws.on('close', (code) => {
    if (sshStream) { try { sshStream.end(); } catch(e){} sshStream = null; }
    if (sshConn) { try { sshConn.end(); } catch(e){} sshConn = null; }
    tcpConnecting = false;
    console.log(`[${new Date().toISOString()}] Disconnected (${code}), reconnect in ${reconnectDelay/1000}s`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 60000);
  });

  ws.on('error', () => {});
}

connect();
AGENTEOF

# ── 创建 systemd 服务 ────────────────────
echo -e "${YELLOW}[4/4] Creating systemd service...${NC}"

cat > /etc/systemd/system/cf-monitor-agent.service << SERVICEEOF
[Unit]
Description=CF-Server-Monitor SSH Agent
After=network.target

[Service]
Type=simple
Environment="AGENT_ID=${AGENT_ID}"
Environment="AGENT_TOKEN=${AGENT_TOKEN}"
Environment="WORKER_URL=${WORKER_URL}"
Environment="SSH_HOST=${SSH_HOST}"
Environment="SSH_PORT=${SSH_PORT}"
Environment="SSH_USER=${SSH_USER}"
Environment="SSH_PASSWORD=${SSH_PASSWORD}"
WorkingDirectory=${AGENT_DIR}
ExecStart=/usr/bin/node ssh-agent.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
SERVICEEOF

systemctl daemon-reload
systemctl enable cf-monitor-agent
systemctl start cf-monitor-agent

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN} Installation complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "Agent ID:    ${AGENT_ID}"
echo "Worker URL:  ${WORKER_URL}"
echo "SSH Target:  ${SSH_USER}@${SSH_HOST}:${SSH_PORT}"
echo ""
echo "Commands:"
echo "  systemctl status cf-monitor-agent   # Check status"
echo "  systemctl restart cf-monitor-agent  # Restart"
echo "  journalctl -u cf-monitor-agent -f   # View logs"
