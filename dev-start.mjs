import { createServer } from 'vite';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = process.cwd();

const server = await createServer({
  root: ROOT,
  configFile: resolve(ROOT, 'vite.config.js'),
  server: { host: true, open: false, port: 5173, strictPort: false },
});

await server.listen();

const urls = server.resolvedUrls;
const localUrl =
  (urls && urls.local && urls.local[0]) ||
  `http://localhost:${server.config.server.port}/`;
const port = server.config.server.port;

writeFileSync(resolve(ROOT, 'server-port.txt'), localUrl, 'utf8');

console.log('');
console.log('  WaterThreeJS dev server');
console.log('  -----------------------');
console.log('  Local:   ' + localUrl);
console.log('  Port:    ' + port);
console.log('  Address saved to server-port.txt');
console.log('  Press Ctrl+C to stop.');
console.log('');

try {
  execSync('start "" "' + localUrl + '"', { stdio: 'ignore' });
} catch (e) {
  // Browser open is best-effort; ignore if no browser is available.
}

server.httpServer.on('close', () => process.exit(0));
