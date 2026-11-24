/**
 * 受限 HTTP 客户端：按域名隔离的 Cookie Jar、手动重定向、只允许访问 *.zju.edu.cn。
 *
 * 独立项目，只依赖 Node 内置能力，不引入任何第三方包。
 * 校园会话（Cookie）只留在内存，不落盘、不写日志。
 */

export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** 是否属于浙江大学域名（含子域名）。 */
export function isZjuHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'zju.edu.cn' || host.endsWith('.zju.edu.cn');
}

/** 校园站点必须直连，不能被系统代理劫走。 */
const DIRECT_HOSTS = ['.zju.edu.cn', 'zju.edu.cn'];

/**
 * 把校园域名塞进 NO_PROXY / no_proxy。
 *
 * 开着 Clash 之类的代理时，一旦代理没启动或换端口，所有 fetch 都会 ECONNREFUSED；
 * 而校园站点本来直连最快。这里在进程启动时补白名单，保证与代理软件状态无关。
 */
export function allowDirectHosts() {
  let added = 0;
  for (const key of ['NO_PROXY', 'no_proxy']) {
    const merged = String(process.env[key] || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    for (const host of DIRECT_HOSTS) {
      if (!merged.includes(host)) {
        merged.push(host);
        added += 1;
      }
    }
    process.env[key] = merged.join(',');
  }
  return added;
}

/** 断言目标主机是学校域名，防止被重定向或参数带到外站。 */
export function assertZjuUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`不支持的协议：${url.protocol}`);
  }
  if (!isZjuHost(url.hostname)) {
    throw new Error(`拒绝访问非浙江大学域名：${url.hostname}`);
  }
  return url;
}

/** 简单的按域名隔离 Cookie Jar。只保留 name/value，忽略 Path/Secure 等属性。 */
export class CookieJar {
  constructor() {
    /** @type {Map<string, Map<string, string>>} */
    this.domains = new Map();
  }

  set(host, line) {
    if (!line) return;
    const parts = String(line).split(';');
    const first = parts[0] || '';
    const eq = first.indexOf('=');
    if (eq <= 0) return;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (!name) return;

    let domain = String(host || '').toLowerCase();
    let expired = false;
    for (let i = 1; i < parts.length; i += 1) {
      const attr = parts[i];
      const idx = attr.indexOf('=');
      const key = (idx >= 0 ? attr.slice(0, idx) : attr).trim().toLowerCase();
      const val = idx >= 0 ? attr.slice(idx + 1).trim() : '';
      if (key === 'domain' && val) domain = val.replace(/^\./, '').toLowerCase();
      if (key === 'max-age' && Number(val) <= 0) expired = true;
      if (key === 'expires' && /1970|Thu, 01 Jan 1970/i.test(val)) expired = true;
    }

    const bucket = this.domains.get(domain) || new Map();
    if (expired || value === '') bucket.delete(name);
    else bucket.set(name, value);
    this.domains.set(domain, bucket);
  }

  header(host) {
    const target = String(host || '').toLowerCase();
    const merged = new Map();
    for (const [domain, cookies] of this.domains) {
      const bare = domain.replace(/^\./, '');
      if (target === bare || target.endsWith(`.${bare}`)) {
        for (const [name, value] of cookies) merged.set(name, value);
      }
    }
    return [...merged.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  value(name) {
    for (const cookies of this.domains.values()) {
      if (cookies.has(name)) return cookies.get(name);
    }
    return null;
  }

  clear() {
    this.domains.clear();
  }

  size() {
    let total = 0;
    for (const cookies of this.domains.values()) total += cookies.size;
    return total;
  }
}

/**
 * 发起一次请求，手动处理重定向以便把每一跳的 Set-Cookie 收进 jar。
 *
 * @param {CookieJar} jar
 * @param {string} rawUrl
 * @param {RequestInit & { headers?: Record<string,string> }} options
 * @param {{ follow?: boolean, maxHops?: number, timeoutMs?: number }} [behavior]
 */
export async function request(jar, rawUrl, options = {}, behavior = {}) {
  const follow = behavior.follow !== false;
  const maxHops = behavior.maxHops ?? 15;
  const timeoutMs = behavior.timeoutMs ?? 20000;

  let current = assertZjuUrl(rawUrl).toString();
  let method = options.method || 'GET';
  let body = options.body;
  let extraHeaders = { ...(options.headers || {}) };
  let hops = 0;

  for (;;) {
    const url = assertZjuUrl(current);
    const headers = {
      'User-Agent': DEFAULT_UA,
      Accept: 'text/html,application/json,*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...extraHeaders,
    };
    const cookie = jar.header(url.hostname);
    if (cookie) headers.Cookie = cookie;

    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err?.cause?.code === 'ECONNRESET' || err?.message?.includes('ECONNRESET')) {
        throw new Error(
          `连接 ${url.hostname} 被重置 (ECONNRESET)。如果开着 Clash/FlClash 等代理的 TUN 模式，` +
            `请确保 *.zju.edu.cn 走直连 (DIRECT)。原始错误：${err.message}`,
        );
      }
      throw err;
    }

    const setCookies =
      typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : res.headers.get('set-cookie')
          ? [res.headers.get('set-cookie')]
          : [];
    for (const line of setCookies) jar.set(url.hostname, line);

    const location = res.headers.get('location');
    if (follow && res.status >= 300 && res.status < 400 && location && hops < maxHops) {
      const next = new URL(location, url);
      if (next.protocol === 'http:' && isZjuHost(next.hostname)) next.protocol = 'https:';
      assertZjuUrl(next.toString());
      current = next.toString();
      hops += 1;
      method = 'GET';
      body = undefined;
      extraHeaders = {};
      continue;
    }

    return { res, url: current, text: () => res.text() };
  }
}

/** 解码常见 HTML 实体。 */
export function decodeEntities(input) {
  return String(input ?? '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

/** 去标签并压缩空白。 */
export function stripTags(html) {
  return decodeEntities(
    String(html ?? '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
