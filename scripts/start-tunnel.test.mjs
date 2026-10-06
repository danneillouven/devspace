import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { extractTunnelUrl } from './start-tunnel.mjs';

const scriptUrl = new URL('./start-tunnel.mjs', import.meta.url).href;

test('extracts only quick tunnel HTTPS origins', () => {
  assert.equal(extractTunnelUrl('INF | https://example-name.trycloudflare.com |'), 'https://example-name.trycloudflare.com');
  assert.equal(extractTunnelUrl('https://developers.cloudflare.com'), undefined);
  assert.equal(extractTunnelUrl('https://fake.trycloudflare.com.evil.example'), undefined);
});

async function fixture(t, mode = 'success') {
  const dir = mkdtempSync(join(tmpdir(), 'devspace-tunnel-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  if (mode !== 'occupied') await new Promise(resolve => reservation.close(resolve));
  else t.after(() => reservation.close());
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ port, allowedRoots: [dir], publicBaseUrl: 'https://old.example', custom: 'preserved' }));
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ ownerToken: 'test-secret-at-least-sixteen-characters' }));
  const cloud = join(dir, 'cloudflared');
  writeFileSync(cloud, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(join(dir, 'tunnel.pid'))}, String(process.pid));
${mode === 'timeout' ? '' : `process.stderr.write('https://test-'); setTimeout(() => process.stderr.write('host.trycloudflare.com\\n'), 20);`}
setTimeout(() => process.stderr.write('Registered tunnel connection\\n'), 50);
setTimeout(() => process.stderr.write('precheck complete\\n'), 1000);
${mode === 'tunnel-failure' ? 'setTimeout(() => process.exit(9), 2000);' : ''}
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  const cli = join(dir, 'cli.mjs');
  writeFileSync(cli, `import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
const dir = process.env.DEVSPACE_CONFIG_DIR;
if (process.argv[2] === 'config') {
 const p = dir + '/config.json'; const c = JSON.parse(readFileSync(p)); c.publicBaseUrl = process.argv[5]; writeFileSync(p, JSON.stringify(c));
} else {
 writeFileSync(dir + '/server.pid', String(process.pid));
 ${mode === 'server-failure' ? 'process.exit(7);' : `writeFileSync(dir + '/env-url', process.env.DEVSPACE_PUBLIC_BASE_URL);
 createServer((req, res) => res.end(JSON.stringify({ok: true, name: 'devspace'}))).listen(${port}, '127.0.0.1');`}
}
`);
  const wrapper = join(dir, 'run.mjs');
  writeFileSync(wrapper, `import { run } from ${JSON.stringify(scriptUrl)};
run({cliPath: ${JSON.stringify(cli)}, cloudflared: ${JSON.stringify(mode === 'missing' ? join(dir, 'absent') : cloud)}, timeoutMs: ${mode === 'timeout' ? 800 : 5000}}).catch(e => { console.error(e.message); process.exitCode = 1; });`);
  const child = spawn(process.execPath, [wrapper], { env: { ...process.env, DEVSPACE_CONFIG_DIR: dir, HOST: '127.0.0.1', PORT: String(port), DEVSPACE_PUBLIC_BASE_URL: 'https://environment.example' } });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let output = '';
  child.stdout.on('data', b => { output += b; });
  child.stderr.on('data', b => { output += b; });
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  return { dir, child, exited, output: () => output };
}

function assertStopped(dir, name) {
  const pid = Number(readFileSync(join(dir, name + '.pid'), 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
}

test('split URL updates config, overrides environment, and Ctrl+C stops both children', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const deadline = Date.now() + 5000;
  while (!f.output().includes('DEVSPACE IS READY') && Date.now() < deadline && f.child.exitCode === null) await new Promise(r => setTimeout(r, 20));
  assert.match(f.output(), /MCP URL:\s+https:\/\/test-host.trycloudflare.com\/mcp/);
  assert.ok(f.output().indexOf('precheck complete') < f.output().indexOf('DEVSPACE IS READY'));
  assert.match(f.output(), /DEVSPACE IS READY/);
  const config = JSON.parse(readFileSync(join(f.dir, 'config.json')));
  assert.equal(config.publicBaseUrl, 'https://test-host.trycloudflare.com');
  assert.equal(config.custom, 'preserved');
  assert.deepEqual(config.allowedRoots, [f.dir]);
  assert.equal(readFileSync(join(f.dir, 'env-url'), 'utf8'), config.publicBaseUrl);
  f.child.kill('SIGINT');
  assert.equal(await f.exited, 0);
  assertStopped(f.dir, 'tunnel');
  assertStopped(f.dir, 'server');
});

for (const [mode, message] of [['missing', /ENOENT/], ['timeout', /Timed out waiting/], ['server-failure', /exited \(7\)/], ['occupied', /EADDRINUSE/]]) {
  test(mode + ' fails clearly and cleans up', { timeout: 10000 }, async t => {
    const f = await fixture(t, mode);
    assert.equal(await f.exited, 1);
    assert.match(f.output(), message);
    assert.doesNotMatch(f.output(), /MCP URL:/);
    if (mode === 'timeout' || mode === 'server-failure') assertStopped(f.dir, 'tunnel');
  });
}

test('tunnel exit stops DevSpace', { timeout: 10000 }, async t => {
  const f = await fixture(t, 'tunnel-failure');
  assert.equal(await f.exited, 1);
  assert.match(f.output(), /exited \(9\)/);
  assertStopped(f.dir, 'server');
});
