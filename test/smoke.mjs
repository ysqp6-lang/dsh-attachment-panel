// dsh-attachment-panel — 最小 smoke 测试
//
// 目标：不依赖 DSH 运行时，验证宿主半边能加载、能注册路由、能把索引和
// Taildrop 设备列表算出来。跑法：`npm test`（或 `node test/smoke.mjs`）。
//
// 说明：测试会真的去扫 ~/.dsh/sessions（只读）和调用一次
// `tailscale debug localapi file-targets`。后者失败不算测试失败——
// 没装 Tailscale 的机器上应该优雅降级。

import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';

const scratch = mkdtempSync(join(tmpdir(), 'dsh-ap-test-'));
process.env.DSH_AP_THUMBS = join(scratch, 'thumbs');
process.env.DSH_AP_CACHE = join(scratch, 'index.json');

const mod = await import('../lib/index.js');
assert.equal(typeof mod.apply, 'function', 'apply 必须导出');
assert.deepEqual(mod.inject, ['webServer'], 'inject 必须是 webServer');

const routes = [];
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  webServer: {
    register(route) {
      routes.push(route);
      return () => {};
    },
  },
};

mod.apply(ctx);
assert.equal(routes.length, 1, '应该只注册一个前缀路由');
assert.equal(routes[0].kind, 'prefix', '路由类型应为 prefix');
assert.equal(routes[0].path, '/dsh-ap', '路由路径应为 /dsh-ap');

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://x').pathname;
  for (const route of routes) {
    if (pathname === route.path || pathname.startsWith(route.path + '/')) {
      route.handler(req, res);
      return;
    }
  }
  res.writeHead(404).end('not found');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/dsh-ap`;

async function get(path) {
  const res = await fetch(base + path, { signal: AbortSignal.timeout(60000) });
  const type = res.headers.get('content-type') ?? '';
  const body = type.includes('application/json') ? await res.json() : await res.text();
  return { status: res.status, type, body };
}

try {
  // 1) 页面
  const page = await get('/');
  assert.equal(page.status, 200, '面板页面应返回 200');
  assert.ok(page.type.includes('text/html'), '面板页面应是 HTML');
  assert.ok(page.body.includes('投送记录'), '页面里应有标题');

  // 2) 健康检查
  const health = await get('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(health.body.pkg, 'dsh-attachment-panel');

  // 3) 索引（首次会扫会话日志，可能要一两秒）
  const index = await get('/api/index?scope=user');
  assert.equal(index.status, 200);
  assert.equal(index.body.ok, true);
  assert.ok(Array.isArray(index.body.items), 'items 应是数组');
  assert.ok(Array.isArray(index.body.files), 'files 应是数组');
  assert.ok(Array.isArray(index.body.sends), 'sends 应是数组');
  assert.ok(typeof index.body.counts === 'object' && index.body.counts !== null, 'counts 应存在');

  // 4) 设备列表：装了 Tailscale 才有数据，没装应返回可控错误而不是崩
  const targets = await get('/api/targets');
  assert.ok([200, 502].includes(targets.status), 'targets 只应返回 200 或 502');
  if (targets.status === 200) assert.ok(Array.isArray(targets.body.targets));

  // 5) 接收扫描：允许 200（含空列表）
  const received = await get('/api/received');
  assert.equal(received.status, 200);
  assert.ok(Array.isArray(received.body.items));
  assert.ok(typeof received.body.pendingCount === 'number');

  // 6) 白名单：不在索引里的路径必须 404
  const bad = await fetch(base + '/api/reveal-path', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: '/etc/passwd' }),
  });
  assert.equal(bad.status, 404, '未索引路径必须拒绝');

  console.log('smoke ok');
  console.log('  sessions indexed:', index.body.counts.all ?? 0, 'items /', index.body.files.length, 'paths /', index.body.sends.length, 'sends');
  console.log('  targets:', targets.status === 200 ? targets.body.targets.length : 'unavailable');
  console.log('  received:', received.body.items.length, 'items (pending', received.body.pendingCount + ')');
} finally {
  server.close();
}
