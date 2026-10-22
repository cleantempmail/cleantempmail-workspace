// 防追踪：移除追踪像素、远程图片经隐私代理加载、清理链接里的跟踪参数
// 发件人通过远程图片（尤其是 1×1 的追踪像素）得知你何时打开邮件、你的 IP、位置和设备。
import type { Env } from "./env";
import { b64url, b64urlDecode, hmacSign } from "./util";

// 链接里常见的跟踪参数（营销平台、广告点击 ID）
const TRACKING_PARAM =
  /^(utm_\w+|fbclid|gclid|gclsrc|dclid|gbraid|wbraid|msclkid|yclid|twclid|ttclid|li_fat_id|igshid|mc_cid|mc_eid|_hsenc|_hsmi|__hssc|__hstc|__hsfp|hsctatracking|mkt_tok|vero_id|vero_conv|oly_anon_id|oly_enc_id|rb_clickid|s_cid|elqtrackid|elqtrack|elqcampaignid|elqaid|elqat|trk|trkcampaign|sc_cid|ml_subscriber|ml_subscriber_hash|ck_subscriber_id|_kx|wickedid|irclickid|irgwc|_branch_match_id|ref_src|ss_source|ss_campaign_id|spm|scid|cmpid|zanpid)$/i;

// 只用来追踪的服务（这些域名上的图片一律视为追踪器）
const TRACKER_HOST =
  /(^|\.)(google-analytics\.com|doubleclick\.net|mailtrack\.io|emltrk\.com|bananatag\.com|t\.yesware\.com|app\.yesware\.com|track\.mixmax\.com|mailfoogae\.appspot\.com|getnotify\.com|r\.superhuman\.com|pixel\.[^.]+\.[^.]+|open\.[^.]+\.[^.]+|tracking\.[^.]+\.[^.]+)$/i;

// 各邮件营销平台的"打开"统计地址
const TRACKER_PATH =
  /\/(wf\/open|track\/open(\.php)?|open\.(php|aspx|gif|png|jpg)|e2t\/o\/|ss\/o\/|e\/o\/|trk\/open|email\/open|mail\/open|tracking\/open|pixel(\.(gif|png))?(\/|\?|$)|beacon(\.(gif|png))?(\/|\?|$)|t\.gif|o\.gif)/i;

const HIDDEN_STYLE = /(display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(\.0+)?\s*(;|$)|max-(height|width)\s*:\s*0)/i;

function tinySize(v: string | null): boolean {
  if (v === null) return false;
  const n = parseFloat(v);
  return !Number.isNaN(n) && n <= 3;
}

function styleSize(style: string, prop: "width" | "height"): string | null {
  const m = style.match(new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([\\d.]+)px`, "i"));
  return m ? m[1] : null;
}

export function isTrackingPixel(src: string, attrs: { width: string | null; height: string | null; style: string }): boolean {
  const w = attrs.width ?? styleSize(attrs.style, "width");
  const h = attrs.height ?? styleSize(attrs.style, "height");
  if ((tinySize(w) && tinySize(h)) || ((tinySize(w) || tinySize(h)) && (w === "0" || h === "0"))) return true;
  if (HIDDEN_STYLE.test(attrs.style)) return true;
  try {
    const u = new URL(src);
    if (TRACKER_HOST.test(u.hostname)) return true;
    if (TRACKER_PATH.test(u.pathname)) return true;
    // Mailgun：email.<域名>/o/<token>；Amazon SES：*.awstrack.me/I0/<token>
    if (/^email\./i.test(u.hostname) && /^\/o\/[\w-]{16,}/.test(u.pathname)) return true;
    if (/(^|\.)awstrack\.me$/i.test(u.hostname) && /^\/I0\//.test(u.pathname)) return true;
  } catch {}
  return false;
}

export function cleanLink(href: string): string | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const drop = [...u.searchParams.keys()].filter((k) => TRACKING_PARAM.test(k));
  if (!drop.length) return null;
  for (const k of new Set(drop)) u.searchParams.delete(k);
  return u.toString();
}

// ---------- 图片代理链接 ----------

export async function proxyUrl(env: Env, target: string): Promise<string> {
  return `/api/img?u=${b64url(new TextEncoder().encode(target))}&s=${await hmacSign(env, target)}`;
}

export async function verifyProxy(env: Env, u: string, s: string): Promise<string | null> {
  let target: string;
  try {
    target = new TextDecoder().decode(b64urlDecode(u));
  } catch {
    return null;
  }
  const expect = await hmacSign(env, target);
  if (expect.length !== s.length) return null;
  let diff = 0;
  for (let i = 0; i < s.length; i++) diff |= expect.charCodeAt(i) ^ s.charCodeAt(i);
  return diff === 0 ? target : null;
}

const CSS_URL = /url\(\s*(['"]?)(https?:\/\/[^'")\s]+)\1\s*\)/gi;

async function replaceAsync(s: string, re: RegExp, fn: (...m: string[]) => Promise<string>): Promise<string> {
  const jobs: Promise<string>[] = [];
  s.replace(re, (...m) => {
    jobs.push(fn(...(m as string[])));
    return "";
  });
  const out = await Promise.all(jobs);
  let i = 0;
  return s.replace(re, () => out[i++]);
}

export interface PrivacyReport {
  trackers: number; // 移除的追踪像素
  links: number; // 清理了跟踪参数的链接
  remote: number; // 远程图片数量（未显示时用于提示）
}

// 改写邮件 HTML。proxy=true 时远程图片改为经代理加载；否则保留原地址，由 CSP 阻止加载
export async function protectHtml(env: Env, doc: string, proxy: boolean): Promise<{ html: string; report: PrivacyReport }> {
  const report: PrivacyReport = { trackers: 0, links: 0, remote: 0 };
  const isRemote = (v: string | null) => Boolean(v && /^\s*(https?:)?\/\//i.test(v));
  const abs = (v: string) => (v.trim().startsWith("//") ? "https:" + v.trim() : v.trim());
  const rewriteCss = (css: string) => (proxy ? replaceAsync(css, CSS_URL, async (_m, q, url) => `url(${q}${await proxyUrl(env, url)}${q})`) : Promise.resolve(css));

  let styleBuf = "";
  const rewriter = new HTMLRewriter()
    .on("img", {
      async element(el) {
        el.removeAttribute("srcset");
        const src = el.getAttribute("src");
        if (!isRemote(src)) return;
        const url = abs(src!);
        if (isTrackingPixel(url, { width: el.getAttribute("width"), height: el.getAttribute("height"), style: el.getAttribute("style") ?? "" })) {
          report.trackers++;
          el.remove();
          return;
        }
        report.remote++;
        if (proxy) el.setAttribute("src", await proxyUrl(env, url));
      },
    })
    .on("source", {
      element(el) {
        el.remove();
      },
    })
    .on("[background]", {
      async element(el) {
        const v = el.getAttribute("background");
        if (!isRemote(v)) return;
        report.remote++;
        if (proxy) el.setAttribute("background", await proxyUrl(env, abs(v!)));
      },
    })
    .on("[style]", {
      async element(el) {
        const v = el.getAttribute("style")!;
        if (!/url\(/i.test(v)) return;
        CSS_URL.lastIndex = 0;
        if (CSS_URL.test(v)) report.remote++;
        CSS_URL.lastIndex = 0;
        el.setAttribute("style", await rewriteCss(v));
      },
    })
    .on("style", {
      async text(t) {
        styleBuf += t.text;
        if (!t.lastInTextNode) {
          t.remove();
          return;
        }
        const css = styleBuf;
        styleBuf = "";
        report.remote += css.match(CSS_URL)?.length ?? 0;
        // <style> 是原始文本元素，按原样写回（转义会破坏 a > b 这类选择器）
        t.replace(await rewriteCss(css), { html: true });
      },
    })
    .on("a[href]", {
      element(el) {
        el.removeAttribute("ping");
        el.setAttribute("rel", "noopener noreferrer");
        const clean = cleanLink(el.getAttribute("href")!);
        if (clean) {
          el.setAttribute("href", clean);
          report.links++;
        }
      },
    })
    // DNS 预解析、预连接、外部样式表、自动跳转都可能泄露"已打开"
    .on("link", {
      element(el) {
        el.remove();
      },
    })
    .on("meta[http-equiv]", {
      element(el) {
        el.remove();
      },
    })
    .on("base[href]", {
      element(el) {
        el.remove();
      },
    });

  const html = await rewriter.transform(new Response(doc, { headers: { "Content-Type": "text/html; charset=utf-8" } })).text();
  return { html, report };
}

// ---------- 图片代理 ----------
const PROXY_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 (via CleanTempMail ImageProxy)";
const MAX_IMAGE = 15 * 1024 * 1024;

export async function serveProxiedImage(env: Env, u: string | undefined, s: string | undefined, selfHost: string): Promise<Response> {
  const fail = (status: number) => new Response(null, { status, headers: { "Cache-Control": "no-store" } });
  if (!u || !s) return fail(400);
  const target = await verifyProxy(env, u, s);
  if (!target) return fail(403);
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return fail(400);
  }
  if (!/^https?:$/.test(url.protocol) || url.hostname === selfHost || url.username || url.password) return fail(400);

  let res: Response;
  try {
    // 不带 Cookie、Referer 和用户的 IP / 设备信息；同一张图片在边缘缓存一天，再次打开不会再请求发件人的服务器
    res = await fetch(url.toString(), {
      headers: { "User-Agent": PROXY_UA, Accept: "image/avif,image/webp,image/png,image/*;q=0.8" },
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
      cf: { cacheTtl: 86400, cacheEverything: true },
    });
  } catch {
    return fail(502);
  }
  const type = (res.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  if (!res.ok || !type.startsWith("image/")) return fail(404);
  const len = Number(res.headers.get("Content-Length") ?? 0);
  if (len > MAX_IMAGE) return fail(413);
  return new Response(res.body, {
    headers: {
      "Content-Type": type,
      "Cache-Control": "private, max-age=86400",
      // SVG 被直接打开时也不能执行脚本
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
}
