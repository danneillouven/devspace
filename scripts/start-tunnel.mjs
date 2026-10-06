import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('..', import.meta.url));

export function extractTunnelUrl(output) {
  return output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com(?=[\s|]|$)/i)?.[0];
}

export async function run({ cliPath = resolve(root, 'dist/cli.js'), cloudflared = 'cloudflared', timeoutMs = 60000 } = {}) {
  if (!existsSync(cliPath)) throw new Error('Built CLI missing. Run: npm run build');
  const { loadConfig } = await import(new URL('../dist/config.js', import.meta.url));
  const { loadDevspaceFiles } = await import(new URL('../dist/user-config.js', import.meta.url));
  const files = loadDevspaceFiles();
  if (!files.configExists || (!files.authExists && !process.env.DEVSPACE_OAUTH_OWNER_TOKEN)) {
    throw new Error('DevSpace setup missing. Run: node dist/cli.js init');
  }
  const config = loadConfig();
  const probe = createServer();
  await new Promise((accept, reject) => {
    probe.once('error', reject);
    probe.listen(config.port, config.host, accept);
  }).catch(error => { throw new Error(`Cannot use ${config.host}:${config.port}: ${error.message}`); });
  await new Promise((accept, reject) => probe.close(error => error ? reject(error) : accept()));
  const localHost = ['0.0.0.0', '::'].includes(config.host) ? '127.0.0.1' : config.host;
  const localUrl = `http://${localHost.includes(':') ? `[${localHost}]` : localHost}:${config.port}`;
  const children = new Set();
  let lastOutputAt = Date.now();
  const controller = new AbortController();
  let stopping = false;
  let failed;
  let finish;
  const completed = new Promise(accept => { finish = accept; });
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    controller.abort();
    finish();
  };
  const fail = error => { if (!stopping) { failed = error; shutdown(); } };
  const launch = (command, args, env = process.env, monitor = true) => {
    const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', () => { lastOutputAt = Date.now(); });
    }
    child.once('error', error => { children.delete(child); fail(new Error(`${command}: ${error.message}`)); });
    child.once('close', (code, signal) => {
      children.delete(child);
      if (monitor) fail(new Error(`${command} exited (${signal ?? code})`));
    });
    return child;
  };
  const waitUntil = async (condition, label) => {
    const deadline = Date.now() + timeoutMs;
    while (!stopping) {
      if (await condition()) return;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
      await delay(100, undefined, { signal: controller.signal });
    }
    throw failed ?? new Error('Startup interrupted');
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  try {
    const tunnel = launch(cloudflared, ['tunnel', '--url', localUrl]);
    let url;
    let tunnelConnected = false;
    for (const stream of [tunnel.stdout, tunnel.stderr]) {
      let buffer = '';
      stream.on('data', chunk => {
        process.stderr.write(chunk);
        buffer = (buffer + chunk.toString()).slice(-16384);
        url ??= extractTunnelUrl(buffer);
        tunnelConnected ||= buffer.includes('Registered tunnel connection');
      });
    }
    await waitUntil(() => Boolean(url), 'Cloudflare tunnel URL');
    const update = launch(process.execPath, [cliPath, 'config', 'set', 'publicBaseUrl', url], process.env, false);
    update.stdout.pipe(process.stdout);
    update.stderr.pipe(process.stderr);
    await new Promise((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out updating DevSpace config')), timeoutMs);
      update.once('close', () => clearTimeout(timer));
      update.once('error', reject);
      update.once('exit', code => code === 0 ? accept() : reject(new Error(`Config update exited (${code})`)));
      controller.signal.addEventListener('abort', () => reject(failed ?? new Error('Startup interrupted')), { once: true });
    });
    if (stopping) throw failed ?? new Error('Startup interrupted');
    const server = launch(process.execPath, [cliPath, 'serve'], { ...process.env, DEVSPACE_PUBLIC_BASE_URL: url });
    server.stdout.pipe(process.stdout);
    server.stderr.pipe(process.stderr);
    await waitUntil(async () => {
      try {
        const response = await fetch(`${localUrl}/healthz`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(1000)]) });
        const health = await response.json();
        return response.ok && health.ok === true && health.name === 'devspace';
      } catch { return false; }
    }, 'DevSpace readiness');
    await waitUntil(() => tunnelConnected, 'Cloudflare tunnel connection');
    // Let delayed connectivity checks and startup logs finish before the banner.
    const settleDeadline = Date.now() + 5000;
    await waitUntil(() => Date.now() - lastOutputAt >= 1500 || Date.now() >= settleDeadline, 'startup output to settle');
    if (!stopping) {
      const endpoint = `${url}/mcp`;
      const highlighted = process.stdout.isTTY ? `\x1b[1;96m${endpoint}\x1b[0m` : endpoint;
      const border = '='.repeat(Math.max(64, endpoint.length + 4));
      console.log(`\n${border}\n  DEVSPACE IS READY\n\n  Keep this terminal open. Ctrl+C stops both processes.\n\n  MCP URL:\n  ${highlighted}\n${border}\n`);
    }
    await completed;
    if (failed) throw failed;
  } catch (error) {
    if (!stopping || failed) throw failed ?? error;
  } finally {
    shutdown();
    await Promise.all([...children].map(child => new Promise(accept => {
      child.once('close', accept);
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      child.once('close', () => clearTimeout(timer));
    })));
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch(error => { console.error(`[devspace:tunnel] ${error.message}`); process.exitCode = 1; });
}
