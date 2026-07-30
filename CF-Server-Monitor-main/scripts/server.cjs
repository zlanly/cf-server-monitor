const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8787;
const DIST = path.join(__dirname, '..', 'dist');

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

http.createServer((req, res) => {
  let url = new URL(req.url, 'http://localhost').pathname;
  if (url === '/') url = '/dashboard.html';

  const filePath = path.join(DIST, url);
  const ext = path.extname(filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('404');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`\n  ✨ CF-Server-Monitor preview: http://localhost:${PORT}`);
  console.log(`     (API 需 wrangler dev，静态资源仅预览前端 UI)\n`);
});
