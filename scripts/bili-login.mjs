#!/usr/bin/env node
/**
 * B 站扫码登录助手（获取 BILI_COOKIE_STRING 与 BILI_REFRESH_TOKEN）
 *
 * 用法：
 *   npm run bili:login                     # 默认：生成二维码 PNG + 本地网页 + 终端二维码
 *   npm run bili:login -- --no-serve       # 只写 PNG 与终端二维码（无网页）
 *   npm run bili:login -- --host=0.0.0.0   # 让同局域网/公网的其他设备打开网页
 *   npm run bili:login -- --out=/opt/sekai-bridge/cache/bili-login-qr.png
 *
 * 服务器（Docker）用法：
 *   docker compose --profile tools run --rm --service-ports bili-login
 *   → 浏览器打开 http://<服务器IP>:18081/ 扫码；成功后直接写入 /app/data/bili-cookies.json
 *
 * 扫码流程（B 站 Web 端官方接口）：
 *   申请二维码 → 手机 B 站 App 扫码并在手机上确认 → 拿到 Cookie 与 refresh_token(ac_time_value)
 *
 * 输出：屏幕打印 + `bili-login.env`（两行 .env 片段，含凭据，贴完请删除）；
 *       容器内检测到 /app/data 时还会直接写入 app 的 cookie 文件（无需改 .env）
 * 该脚本只在需要重新登录时一次性运行，不属于应用运行时逻辑。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const GENERATE_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate';
const POLL_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll';
const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** 请求头（贴近浏览器，降低风控概率）。 */
function browserHeaders(cookie) {
  return {
    'user-agent': BROWSER_UA,
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    origin: 'https://www.bilibili.com',
    referer: 'https://www.bilibili.com/',
    ...(cookie ? { cookie } : {}),
  };
}

/** 登录成功后需要保留的 Cookie（顺序固定便于比对）。 */
const COOKIE_ORDER = [
  'SESSDATA',
  'bili_jct',
  'DedeUserID',
  'DedeUserID__ckMd5',
  'sid',
  'b_nut',
  'buvid3',
  'buvid4',
];

/** 解析 set-cookie 头为 name → value。 */
export function parseSetCookies(headers) {
  const cookies = new Map();
  for (const header of headers ?? []) {
    const pair = header.split(';')[0] ?? '';
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
  return cookies;
}

/**
 * 拼成可直接放进 .env 的 Cookie 串：
 * 过滤含引号/分号/空白的值（否则 docker compose 的 .env 解析会出错）。
 */
export function buildCookieString(cookies) {
  const parts = [];
  const skipped = [];
  for (const name of COOKIE_ORDER) {
    const value = cookies.get(name);
    if (!value) continue;
    if (/["';\s]/.test(value)) {
      skipped.push(name);
      continue;
    }
    parts.push(`${name}=${value}`);
  }
  return { cookieString: parts.join('; '), skipped };
}

export function parseArgs(argv) {
  const options = {
    out: process.env.CACHE_ROOT
      ? path.join(process.env.CACHE_ROOT, 'bili-login-qr.png')
      : 'bili-login-qr.png',
    envOut: 'bili-login.env',
    host: '127.0.0.1',
    port: 18081,
    serve: true,
    terminal: true,
    timeoutSec: 150,
    maxQr: 3,
    // 容器内（/app/data 存在）默认直接写 app 的 cookie 文件；本地运行则不写
    cookieFile:
      process.env.BILI_COOKIE_FILE ||
      (fs.existsSync('/app/data') ? '/app/data/bili-cookies.json' : null),
  };
  for (const arg of argv) {
    if (arg === '--no-serve') options.serve = false;
    else if (arg === '--no-terminal') options.terminal = false;
    else if (arg === '--no-cookie-file') options.cookieFile = null;
    else if (arg.startsWith('--out=')) options.out = arg.slice(6);
    else if (arg.startsWith('--env-out=')) options.envOut = arg.slice(10);
    else if (arg.startsWith('--cookie-file=')) options.cookieFile = arg.slice(14);
    else if (arg.startsWith('--host=')) options.host = arg.slice(7);
    else if (arg.startsWith('--port=')) options.port = Number.parseInt(arg.slice(7), 10);
    else if (arg.startsWith('--timeout=')) options.timeoutSec = Number.parseInt(arg.slice(10), 10);
    else if (arg.startsWith('--max-qr=')) options.maxQr = Number.parseInt(arg.slice(9), 10);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else {
      console.error(`未知参数: ${arg}（--help 查看用法）`);
      process.exit(2);
    }
  }
  return options;
}

/** app 侧 cookie 文件的格式（src/bilibili/client.ts 读取同一结构）。 */
export function buildCookieFilePayload(cookieString, refreshToken) {
  return { cookieString, refreshToken, updatedAt: new Date().toISOString() };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url) {
  const response = await fetch(url, { headers: browserHeaders() });
  const payload = await response.json();
  return { response, payload };
}

/** 申请二维码：返回 { url, qrcodeKey }。 */
export async function generateQr() {
  const { payload } = await fetchJson(GENERATE_URL);
  if (payload.code !== 0 || !payload.data?.qrcode_key) {
    throw new Error(`申请二维码失败: ${payload.message ?? payload.code}`);
  }
  return { url: payload.data.url, qrcodeKey: payload.data.qrcode_key };
}

/** 查一次扫码状态：返回 { state, data, setCookies }。 */
export async function pollOnce(qrcodeKey) {
  const response = await fetch(`${POLL_URL}?qrcode_key=${encodeURIComponent(qrcodeKey)}`, {
    headers: browserHeaders(),
  });
  const payload = await response.json();
  const data = payload.data ?? {};
  const setCookies = response.headers.getSetCookie?.() ?? [];
  if (payload.code !== 0) {
    return { state: 'error', message: payload.message ?? `code=${payload.code}`, data, setCookies };
  }
  switch (data.code) {
    case 0:
      return { state: 'ok', message: '登录成功', data, setCookies };
    case 86038:
      return { state: 'expired', message: '二维码已失效', data, setCookies };
    case 86090:
      return { state: 'scanned', message: '已扫码，请在手机上确认', data, setCookies };
    case 86101:
      return { state: 'waiting', message: '等待扫码', data, setCookies };
    default:
      return { state: 'waiting', message: data.message ?? `状态 ${data.code}`, data, setCookies };
  }
}

function renderPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>B 站扫码登录 · SekaiBridge</title>
<style>
  body { font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; background:#f6f7f9;
         margin:0; display:flex; min-height:100vh; align-items:center; justify-content:center; }
  .card { background:#fff; padding:28px 32px; border-radius:14px; box-shadow:0 8px 30px rgba(0,0,0,.08); text-align:center; }
  h1 { font-size:18px; margin:0 0 6px; }
  p { color:#666; font-size:13px; margin:6px 0; }
  img { width:300px; height:300px; image-rendering:pixelated; margin:8px 0; }
  #status { font-size:15px; font-weight:600; color:#0a7d32; min-height:22px; }
  code { font-size:11px; color:#999; word-break:break-all; display:block; margin-top:10px; }
</style>
</head>
<body>
  <div class="card">
    <h1>用手机 B 站 App 扫码登录</h1>
    <p>登录的是发布账号（如 Project_SEKAI资讯站），确认后本页会提示成功</p>
    <img src="/qr.png" alt="登录二维码">
    <div id="status">等待扫码…</div>
    <p>二维码 3 分钟内有效；成功后本容器会自动退出（结果见终端输出）</p>
    <code id="url"></code>
  </div>
<script>
  async function tick() {
    try {
      const r = await fetch('/status', { cache: 'no-store' });
      const s = await r.json();
      document.getElementById('status').textContent = s.message;
      document.getElementById('status').style.color = s.state === 'ok' ? '#0a7d32' : (s.state === 'expired' ? '#c0392b' : '#b26a00');
      if (s.qr) document.getElementById('url').textContent = s.qr;
      if (s.state === 'ok') return;
    } catch (e) {}
    setTimeout(tick, 2000);
  }
  tick();
</script>
</body>
</html>`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      [
        '用法: npm run bili:login -- [选项]',
        '  --out=<path>       二维码 PNG 输出路径（默认 CACHE_ROOT/bili-login-qr.png 或 ./bili-login-qr.png）',
        '  --env-out=<path>   .env 片段输出路径（默认 ./bili-login.env）',
        '  --cookie-file=<path>  直接写入 app 的 cookie 文件（容器内默认 /app/data/bili-cookies.json）',
        '  --no-cookie-file   不写 cookie 文件',
        '  --host=127.0.0.1   网页监听地址（默认仅本机；0.0.0.0 可让其他设备访问）',
        '  --port=18081       网页端口',
        '  --no-serve         不启动本地网页',
        '  --no-terminal      不在终端打印二维码',
        '  --timeout=<秒>     单次等待扫码的秒数（默认 150）',
        '  --max-qr=<n>       二维码失效后最多重新生成几次（默认 3）',
      ].join('\n'),
    );
    return;
  }

  let QRCode;
  try {
    QRCode = (await import('qrcode')).default;
  } catch {
    console.error('缺少依赖 qrcode：请先在仓库目录执行 `npm install`');
    process.exit(1);
  }

  const state = { state: 'waiting', message: '等待扫码…', qr: '' };
  let png = Buffer.alloc(0);
  let server = null;

  if (options.serve) {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname === '/qr.png') {
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
        res.end(png);
        return;
      }
      if (url.pathname === '/status') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(state));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderPage());
    });
    await new Promise((resolve) => server.listen(options.port, options.host, resolve));
    const shown = options.host === '0.0.0.0' ? '<服务器IP>' : options.host;
    console.log(`[bili-login] 网页二维码: http://${shown}:${options.port}/`);
  }

  const close = () => {
    if (server) {
      server.close();
      server = null;
    }
  };

  try {
    for (let attempt = 1; attempt <= options.maxQr; attempt += 1) {
      const { url, qrcodeKey } = await generateQr();
      png = await QRCode.toBuffer(url, { width: 360, margin: 1 });
      fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
      await QRCode.toFile(options.out, url, { width: 360, margin: 1 });
      state.state = 'waiting';
      state.message = `等待扫码…（第 ${attempt}/${options.maxQr} 个二维码）`;
      state.qr = url;

      console.log(`\n[bili-login] 二维码已生成（第 ${attempt}/${options.maxQr} 个）`);
      console.log(`[bili-login] PNG: ${path.resolve(options.out)}`);
      if (options.terminal) {
        console.log(await QRCode.toString(url, { type: 'terminal', small: true }));
      }
      console.log('[bili-login] 若二维码显示不正常，可把上面二维码对应的链接粘到手机浏览器打开：');
      console.log(`[bili-login] ${url}\n`);

      const deadline = Date.now() + options.timeoutSec * 1000;
      let expired = false;
      while (Date.now() < deadline) {
        const result = await pollOnce(qrcodeKey);
        if (result.state !== state.state || result.message !== state.message) {
          state.state = result.state;
          state.message = result.message;
          if (result.state !== 'waiting') {
            console.log(`[bili-login] ${result.message}`);
          }
        }
        if (result.state === 'ok') {
          state.message = '登录成功，可以关闭本页面';
          await onSuccess(result, options);
          return;
        }
        if (result.state === 'expired') {
          expired = true;
          state.state = 'expired';
          state.message = '二维码已失效，正在重新生成…';
          console.log('[bili-login] 二维码已失效，重新生成…');
          break;
        }
        if (result.state === 'error') {
          throw new Error(result.message);
        }
        await sleep(2000);
      }
      if (!expired) {
        console.log('[bili-login] 等待超时，重新生成二维码…');
      }
    }
    console.error('[bili-login] 多次二维码都未完成扫码，请重新运行。');
    process.exitCode = 1;
  } finally {
    await sleep(1500);
    close();
  }
}

/** 登录成功：核对账号 → 打印/落盘 Cookie 与 refresh_token。 */
async function onSuccess(result, options) {
  const cookies = parseSetCookies(result.setCookies);
  const { cookieString, skipped } = buildCookieString(cookies);
  const refreshToken = result.data?.refresh_token ?? '';
  if (!cookieString.includes('SESSDATA=') || !refreshToken) {
    console.error('[bili-login] 登录响应缺少 SESSDATA 或 refresh_token，可能被风控拦截，请重试。');
    process.exitCode = 1;
    return;
  }

  // 用新 Cookie 查一次账号信息，确认登录的是哪个账号
  let who = '未知账号';
  try {
    const nav = await fetch(NAV_URL, { headers: browserHeaders(cookieString) }).then((r) => r.json());
    if (nav?.data?.isLogin) {
      who = `${nav.data.uname}（UID ${nav.data.mid}）`;
    }
  } catch {
    // 账号信息只是确认，失败不影响结果
  }

  const envContent = [
    '# 由 bili-login 生成；贴到服务器 .env 后请删除本文件',
    `BILI_COOKIE_STRING=${cookieString}`,
    `BILI_REFRESH_TOKEN=${refreshToken}`,
    '',
  ].join('\n');
  const envPath = path.resolve(options.envOut);
  fs.writeFileSync(envPath, envContent, { mode: 0o600 });

  // 容器内：直接写 app 的 cookie 文件（app 读文件优先于 .env，省去改 .env 的步骤）
  let cookieFilePath = null;
  if (options.cookieFile) {
    try {
      const target = path.resolve(options.cookieFile);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(buildCookieFilePayload(cookieString, refreshToken), null, 2), {
        mode: 0o600,
      });
      cookieFilePath = target;
    } catch (error) {
      console.error(
        `[bili-login] cookie 文件写入失败（${options.cookieFile}）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  console.log('\n================ 登录成功 ================');
  console.log(`账号：${who}`);
  if (skipped.length > 0) {
    console.log(`已跳过含特殊字符的值：${skipped.join(', ')}`);
  }
  console.log('\nBILI_COOKIE_STRING=' + cookieString);
  console.log('BILI_REFRESH_TOKEN=' + refreshToken);
  console.log(`\n.env 片段文件：${envPath}（含凭据，贴完请删除）`);

  if (cookieFilePath) {
    console.log(`\n已直接写入 app 的 cookie 文件：${cookieFilePath}`);
    console.log('接下来只需要重启 app（无需改 .env）：');
    console.log('  docker compose up -d app');
    console.log('  docker compose logs -f app | grep -i bilibili');
  } else {
    console.log('\n服务器上更新 .env 后执行：');
    console.log('  docker compose up -d --build app');
    console.log('  docker compose exec app rm -f /app/data/bili-cookies.json');
    console.log('  docker compose restart app');
    console.log('  docker compose logs -f app | grep -i bilibili');
  }
  console.log('=========================================\n');
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  main().catch((error) => {
    console.error('[bili-login] 失败:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
