#!/usr/bin/env node
/**
 * B 站扫码登录助手（生成 /app/data/bili-cookies.json：Cookie 串 + 刷新口令）
 *
 * 用法：
 *   npm run bili:login                     # 生成二维码 PNG + 终端二维码，等待扫码
 *   npm run bili:login -- --no-terminal    # 只写 PNG（终端显示不正常时用）
 *   npm run bili:login -- --out=/opt/sekai-bridge/cache/bili-login-qr.png
 *
 * 服务器（Docker）用法：
 *   docker compose --profile tools run --rm bili-login
 *   → 终端扫码；终端二维码看不清就把 cache/bili-login-qr.png 下载下来扫
 *   → 成功后凭据写入 /app/data/bili-cookies.json
 *
 * 扫码流程（B 站 Web 端官方接口）：
 *   申请二维码 → 手机 B 站 App 扫码并在手机上确认 → 拿到 Cookie 与 refresh_token(ac_time_value)
 *
 * 输出：凭据文件（应用唯一读取来源）+ 二维码 PNG + 终端二维码。
 * 该脚本只在需要重新登录时一次性运行，不属于应用运行时逻辑。
 */
import fs from 'node:fs';
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
    terminal: true,
    timeoutSec: 150,
    maxQr: 3,
    // 凭据固定写进 app 的数据卷（容器内 /app/data）；本地跑则写当前目录，之后可用 docker compose cp 拷进去
    cookieFile: fs.existsSync('/app/data')
      ? '/app/data/bili-cookies.json'
      : 'bili-login-cookies.json',
  };
  for (const arg of argv) {
    if (arg === '--no-terminal') options.terminal = false;
    else if (arg.startsWith('--out=')) options.out = arg.slice(6);
    else if (arg.startsWith('--cookie-file=')) options.cookieFile = arg.slice(14);
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      [
        '用法: npm run bili:login -- [选项]',
        '  --out=<path>       二维码 PNG 输出路径（默认 CACHE_ROOT/bili-login-qr.png 或 ./bili-login-qr.png）',
        '  --cookie-file=<path>  凭据文件输出路径（容器内默认 /app/data/bili-cookies.json）',
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

  for (let attempt = 1; attempt <= options.maxQr; attempt += 1) {
    const { url, qrcodeKey } = await generateQr();
    fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
    await QRCode.toFile(options.out, url, { width: 360, margin: 1 });

    console.log(`\n[bili-login] 二维码已生成（第 ${attempt}/${options.maxQr} 个）`);
    console.log(`[bili-login] 二维码图片: ${path.resolve(options.out)}`);
    if (options.terminal) {
      console.log(await QRCode.toString(url, { type: 'terminal', small: true }));
    }
    console.log('[bili-login] 终端里显示不正常时，把上面这张 PNG 下载到本地（scp/sftp）再扫。');
    console.log('[bili-login] 也可以在手机浏览器直接打开这条链接：');
    console.log(`[bili-login] ${url}\n`);

    const deadline = Date.now() + options.timeoutSec * 1000;
    let expired = false;
    let lastMessage = '';
    while (Date.now() < deadline) {
      const result = await pollOnce(qrcodeKey);
      if (result.message !== lastMessage) {
        lastMessage = result.message;
        if (result.state !== 'waiting') {
          console.log(`[bili-login] ${result.message}`);
        }
      }
      if (result.state === 'ok') {
        await onSuccess(result, options);
        return;
      }
      if (result.state === 'expired') {
        expired = true;
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

  // 凭据只写进 app 的数据盘文件（应用唯一读取来源）
  let cookieFilePath = null;
  try {
    const target = path.resolve(options.cookieFile);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      JSON.stringify(buildCookieFilePayload(cookieString, refreshToken), null, 2),
      { mode: 0o600 },
    );
    cookieFilePath = target;
  } catch (error) {
    console.error(
      `[bili-login] cookie 文件写入失败（${options.cookieFile}）：${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
    return;
  }

  console.log('\n================ 登录成功 ================');
  console.log(`账号：${who}`);
  if (skipped.length > 0) {
    console.log(`已跳过含特殊字符的值：${skipped.join(', ')}`);
  }
  console.log(`凭据已写入：${cookieFilePath}`);

  const inContainer = cookieFilePath.startsWith(path.sep) && cookieFilePath.includes('/app/data/');
  if (inContainer) {
    console.log('\n接下来重启 app 即可（凭据只在文件里，无需改 .env）：');
    console.log('  docker compose up -d app');
    console.log('  docker compose logs -f app | grep -i bilibili');
  } else {
    console.log('\n这是本机运行：把凭据文件拷进容器，然后重启 app：');
    console.log(`  docker compose cp ${cookieFilePath} app:/app/data/bili-cookies.json`);
    console.log('  docker compose up -d app');
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
