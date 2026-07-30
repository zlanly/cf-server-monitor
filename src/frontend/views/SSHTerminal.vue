<template>
  <div class="ssh-terminal">
    <div class="ssh-terminal-header">
      <div class="ssh-info">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="2" y="2" width="20" height="20" rx="2"/>
          <path d="M7 15l3-3-3-3"/>
          <line x1="13" y1="12" x2="17" y2="12"/>
        </svg>
        <span>{{ serverName || 'SSH Terminal' }}</span>
      </div>
      <div class="ssh-actions">
        <span class="ssh-status" :class="statusClass">{{ statusText }}</span>
        <button class="ssh-btn" @click="disconnect" :disabled="!connected && !connecting">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/>
          </svg>
        </button>
      </div>
    </div>
    <div class="ssh-terminal-body" ref="terminalContainer">
      <div v-if="connecting" class="terminal-connecting">
        <div class="loading-spinner"></div>
        <span>Connecting via agent tunnel…</span>
      </div>
    </div>
  </div>
</template>

<script>
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

export default {
  name: 'SSHTerminal',
  props: {
    serverId: { type: String, required: true },
    serverName: { type: String, default: '' },
  },
  data() {
    return {
      connected: false,
      connecting: false,
      term: null,
      fitAddon: null,
      ws: null,
      resizeObserver: null,
      statusText: 'Disconnected',
      statusClass: 'disconnected',
    };
  },
  async mounted() {
    await this.initTerminal();
    // 自动连接
    this.$nextTick(() => {
      setTimeout(() => this.connect(), 100);
    });
  },
  beforeUnmount() {
    this.cleanup();
  },
  methods: {
    cleanup() {
      if (this.ws) {
        try { this.ws.close(); } catch(e) {}
        this.ws = null;
      }
      if (this.resizeObserver) {
        this.resizeObserver.disconnect();
        this.resizeObserver = null;
      }
      if (this.term) {
        this.term.dispose();
        this.term = null;
      }
    },
    disconnect() {
      this.cleanup();
      this.$router.push('/server/' + this.serverId);
    },
    async initTerminal() {
      this.term = new Terminal({
        cursorBlink: true,
        cursorStyle: 'bar',
        fontSize: 14,
        fontFamily: 'Consolas, "Courier New", "Source Code Pro", monospace',
        theme: {
          background: '#1a1b26',
          foreground: '#a9b1d6',
          cursor: '#c0caf5',
          selectionBackground: '#33467c',
          black: '#32344a',
          red: '#f7768e',
          green: '#9ece6a',
          yellow: '#e0af68',
          blue: '#7aa2f7',
          magenta: '#ad8ee6',
          cyan: '#449dab',
          white: '#787c99',
          brightBlack: '#444b6a',
          brightRed: '#ff7a93',
          brightGreen: '#b9f27c',
          brightYellow: '#ff9e64',
          brightBlue: '#7da6ff',
          brightMagenta: '#bb9af7',
          brightCyan: '#0db9d7',
          brightWhite: '#acb0d0',
        },
        allowProposedApi: true,
      });

      this.fitAddon = new FitAddon();
      this.term.loadAddon(this.fitAddon);
      this.term.loadAddon(new WebLinksAddon());

      this.$nextTick(() => {
        this.term.open(this.$refs.terminalContainer);
        this.fitAddon.fit();
      });

      this.resizeObserver = new ResizeObserver(() => {
        try { this.fitAddon.fit(); } catch(e) {}
      });
      this.resizeObserver.observe(this.$refs.terminalContainer);
    },
    connect() {
      if (this.connecting || this.connected) return;
      this.connecting = true;
      this.statusText = 'Connecting...';
      this.statusClass = 'connecting';

      const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const token = localStorage.getItem('auth_token') || '';
      const wsUrl = `${wsProtocol}//${location.host}/api/ssh-terminal?type=terminal&server_id=${encodeURIComponent(this.serverId)}&token=${encodeURIComponent(token)}`;

      this.ws = new WebSocket(wsUrl);
      // 使用二进制类型确保透传不变形
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => {
        this.connecting = false;
        this.connected = true;
        this.statusText = 'Connected';
        this.statusClass = 'connected';
        if (this.term) this.term.focus();
      };

      this.ws.onmessage = (event) => {
        if (!this.term) return;
        // Agent 发来的 SSH 输出，直接写入终端
        if (event.data instanceof ArrayBuffer) {
          this.term.write(new Uint8Array(event.data));
        } else {
          this.term.write(event.data);
        }
      };

      this.ws.onclose = (event) => {
        this.connected = false;
        this.connecting = false;
        this.statusText = 'Disconnected';
        this.statusClass = 'disconnected';
        if (this.term) {
          const reason = event.reason || event.code;
          if (event.code !== 1000) {
            this.term.write(`\r\n\x1b[33m[连接断开: ${reason}]\x1b[0m\r\n`);
            if (event.code === 1011) {
              this.term.write('\x1b[31mAgent 未连接。请在目标服务器上运行 Agent 程序。\x1b[0m\r\n');
            }
          } else {
            this.term.write('\r\n\x1b[33m[连接已关闭]\x1b[0m\r\n');
          }
        }
      };

      this.ws.onerror = () => {
        this.connecting = false;
        this.statusText = 'Error';
        this.statusClass = 'error';
        if (this.term) {
          this.term.write('\r\n\x1b[31m[WebSocket 错误]\x1b[0m\r\n');
        }
      };

      // 终端按键 → Agent（纯透传）
      this.term.onData((data) => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(data);
        }
      });
    },
  },
};
</script>

<style scoped>
.ssh-terminal {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: #1a1b26;
}

.ssh-terminal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 16px;
  background: #24283b;
  border-bottom: 1px solid #3b4261;
  flex-shrink: 0;
}

.ssh-info {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #a9b1d6;
  font-size: 13px;
  font-family: monospace;
}

.ssh-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.ssh-status {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 4px;
  font-family: monospace;
}

.ssh-status.connecting { background: #0f4c75; color: #7aa2f7; }
.ssh-status.connected { background: #1a3a1a; color: #9ece6a; }
.ssh-status.disconnected { background: #3a2a1a; color: #e0af68; }
.ssh-status.error { background: #3a1a1a; color: #f7768e; }

.ssh-btn {
  background: none;
  border: 1px solid #3b4261;
  color: #a9b1d6;
  padding: 4px 8px;
  border-radius: 4px;
  cursor: pointer;
  display: flex;
  align-items: center;
}

.ssh-btn:hover { background: #3b4261; }
.ssh-btn:disabled { opacity: 0.4; cursor: default; }

.ssh-terminal-body {
  flex: 1;
  padding: 4px;
  overflow: hidden;
}

.terminal-connecting {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #7aa2f7;
  font-family: monospace;
  gap: 16px;
}

.loading-spinner {
  width: 24px;
  height: 24px;
  border: 2px solid #3b4261;
  border-top-color: #7aa2f7;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
