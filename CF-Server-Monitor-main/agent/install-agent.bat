@echo off
REM CF-Server-Monitor SSH Agent 一键安装脚本 (Windows)
REM 右键 → 以管理员身份运行

setlocal enabledelayedexpansion

echo ================================================
echo  CF-Server-Monitor SSH Agent Installer (Windows)
echo ================================================
echo.

set /p WORKER_URL="Worker URL (如 wss://cf-monitor.xxx.workers.dev): "
set /p AGENT_ID="Agent ID: "
set /p AGENT_TOKEN="Agent Token: "
set /p SSH_HOST="SSH Host [127.0.0.1]: "
if "%SSH_HOST%"=="" set SSH_HOST=127.0.0.1
set /p SSH_PORT="SSH Port [22]: "
if "%SSH_PORT%"=="" set SSH_PORT=22
set /p SSH_USER="SSH User [root]: "
if "%SSH_USER%"=="" set SSH_USER=root
set /p SSH_PASSWORD="SSH Password: "

set AGENT_DIR=C:\cf-monitor-agent
if not exist "%AGENT_DIR%" mkdir "%AGENT_DIR%"

REM ── 检查 Node.js ─────────────────
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [1/4] Node.js not found, downloading...
    powershell -Command "Invoke-WebRequest -Uri 'https://npmmirror.com/mirrors/node/v20.18.0/node-v20.18.0-win-x64.zip' -OutFile '%TEMP%\node.zip'"
    powershell -Command "Expand-Archive -Path '%TEMP%\node.zip' -DestinationPath 'C:\nodejs' -Force"
    set PATH=C:\nodejs\node-v20.18.0-win-x64;%PATH%
    setx PATH "C:\nodejs\node-v20.18.0-win-x64;%PATH%" >nul
    echo [1/4] Node.js installed
) else (
    echo [1/4] Node.js found
)

REM ── 安装 ws + ssh2 模块 ────────────────
echo [2/4] Installing ws and ssh2 modules...
cd /d "%AGENT_DIR%"
npm init -y --silent >nul 2>&1
npm install ws ssh2 --save >nul 2>&1
echo [2/4] Done

REM ── 生成 Agent 脚本 ──────────────
echo [3/4] Creating agent script...
> ssh-agent.js (
echo // CF-Server-Monitor SSH Agent ^(ssh2^)
echo const WebSocket = require('ws'^);
echo const { Client } = require('ssh2'^);
echo.
echo const AGENT_ID = '%AGENT_ID%';
echo const AGENT_TOKEN = '%AGENT_TOKEN%';
echo const WORKER_URL = '%WORKER_URL%'.replace(/\/$/, ''^);
echo const SSH_HOST = '%SSH_HOST%';
echo const SSH_PORT = %SSH_PORT%;
echo const SSH_USER = '%SSH_USER%';
echo const SSH_PASSWORD = '%SSH_PASSWORD%';
echo.
echo let sshConn = null;
echo let sshStream = null;
echo let reconnectDelay = 5000;
echo let tcpConnecting = false;
echo.
echo function connect(^) {
echo   const wsUrl = `${WORKER_URL}/api/ssh-agent?type=agent^&agent_id=${encodeURIComponent(AGENT_ID^)}^&token=${encodeURIComponent(AGENT_TOKEN^)}`;
echo   const ws = new WebSocket(wsUrl^);
echo.
echo   ws.on('open', (^) =^> { console.log(`[${new Date(^).toISOString(^)}] Connected`^); reconnectDelay = 5000; }^);
echo.
echo   ws.on('message', (data^) =^> {
echo     let ctrl = null;
echo     try { const t = Buffer.isBuffer(data^) ? data.slice(0,32^).toString(^) : String(data^).slice(0,32^); if (t.startsWith('{"t":'^)^) ctrl = JSON.parse(t^); } catch(e^) {}
echo     if (ctrl ^&^& ctrl.t === 'r'^) { if (sshStream^) { try{sshStream.end(^);}catch(e){} sshStream = null; } if (sshConn^) { try{sshConn.end(^);}catch(e){} sshConn = null; } tcpConnecting = false; return; }
echo     if (!sshStream ^&^& !tcpConnecting^) {
echo       tcpConnecting = true;
echo       sshConn = new Client(^);
echo       sshConn.on('ready', (^) =^> {
echo         sshConn.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err, stream^) =^> {
echo           tcpConnecting = false;
echo           if (err^) { if (ws.readyState === 1^) { ws.send(`\r\n\x1b[31m${err.message}\x1b[0m\r\n`^); ws.close(^); } return; }
echo           sshStream = stream;
echo           stream.on('data', c =^> { if (ws.readyState === 1^) ws.send(c^); }^);
echo           stream.on('close', (^) =^> { sshStream = null; if (ws.readyState === 1^) ws.close(^); }^);
echo           stream.stderr.on('data', c =^> { if (ws.readyState === 1^) ws.send(c^); }^);
echo           if (data ^&^& data.length ^> 0^) stream.write(data^);
echo         }^);
echo       }^);
echo       sshConn.on('error', e =^> { tcpConnecting = false; if (ws.readyState === 1^) { ws.send(`\r\n\x1b[31m${e.message}\x1b[0m\r\n`^); ws.close(^); } }^);
echo       sshConn.on('close', (^) =^> { sshStream = null; sshConn = null; tcpConnecting = false; if (ws.readyState === 1^) ws.close(^); }^);
echo       sshConn.connect({ host: SSH_HOST, port: SSH_PORT, username: SSH_USER, password: SSH_PASSWORD, readyTimeout: 15000 }^);
echo     } else if (sshStream^) { sshStream.write(data^); }
echo   }^);
echo.
echo   ws.on('close', (code^) =^> {
echo     if (sshStream^) { try{sshStream.end(^);}catch(e){} sshStream = null; }
echo     if (sshConn^) { try{sshConn.end(^);}catch(e){} sshConn = null; }
echo     tcpConnecting = false;
echo     setTimeout(connect, reconnectDelay^);
echo     reconnectDelay = Math.min(reconnectDelay * 2, 60000^);
echo   }^);
echo   ws.on('error', (^) =^> {}^);
echo }
echo connect(^);
)

REM ── 注册 Windows 服务 ────────────
echo [4/4] Registering service...
sc create "CFMonitorAgent" binPath="%AGENT_DIR%\agent-launcher.cmd" start=auto >nul 2>&1 || sc config "CFMonitorAgent" start=auto >nul 2>&1

> "%AGENT_DIR%\agent-launcher.cmd" (
echo @echo off
echo cd /d "%AGENT_DIR%"
echo node ssh-agent.js
)

sc start CFMonitorAgent >nul 2>&1

echo.
echo ================================================
echo  Installation complete!
echo ================================================
echo.
echo Agent ID:    %AGENT_ID%
echo Worker URL:  %WORKER_URL%
echo SSH Target:  %SSH_USER%@%SSH_HOST%:%SSH_PORT%
echo.
echo Commands:
echo   sc query CFMonitorAgent     # Check status
echo   sc stop CFMonitorAgent      # Stop
echo   sc start CFMonitorAgent     # Start
echo.

endlocal
