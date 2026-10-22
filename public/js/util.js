// 通用工具：转义、时间、文件大小、头像颜色等
// 界面语言：auto 跟随浏览器
export function lang() {
  let p = "auto";
  try {
    p = JSON.parse(localStorage.getItem("cfm:lang") || '"auto"');
  } catch {}
  if (p === "zh" || p === "en") return p;
  return (navigator.language || "zh").toLowerCase().startsWith("zh") ? "zh" : "en";
}
const EN = () => lang() === "en";
const LOCALE = () => (EN() ? "en-US" : "zh-CN");
const WEEK_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const WEEK_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export const parseList = (s) => {
  if (Array.isArray(s)) return s;
  try {
    return JSON.parse(s || "[]");
  } catch {
    return [];
  }
};

export const isEmail = (s) => /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(s);
export const addrText = (a) => (a.name ? `${a.name} <${a.address}>` : a.address);
export const displayName = (name, address) => name || (address ? address.split("@")[0] : "");

const DAY = 86400000;
function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

const hm = (d) => d.toLocaleTimeString(LOCALE(), { hour: "2-digit", minute: "2-digit", hour12: false });

export function fmtListTime(ts) {
  const d = new Date(ts * 1000);
  const today = startOfDay(Date.now());
  const en = EN();
  if (d.getTime() >= today) return hm(d);
  if (d.getTime() >= today - DAY) return en ? "Yesterday" : "昨天";
  if (d.getTime() >= today - 6 * DAY) return (en ? WEEK_EN : WEEK_ZH)[d.getDay()];
  if (d.getFullYear() === new Date().getFullYear()) return en ? `${MONTH_EN[d.getMonth()]} ${d.getDate()}` : `${d.getMonth() + 1}月${d.getDate()}日`;
  return en ? `${MONTH_EN[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}` : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

export function fmtFull(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleString(LOCALE(), { year: "numeric", month: EN() ? "short" : "long", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
}

export function fmtRelative(ts) {
  const diff = Date.now() / 1000 - ts;
  const en = EN();
  if (diff < 60) return en ? "Just now" : "刚刚";
  if (diff < 3600) return en ? `${Math.floor(diff / 60)} min ago` : `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return en ? `${Math.floor(diff / 3600)} h ago` : `${Math.floor(diff / 3600)} 小时前`;
  return fmtListTime(ts);
}

export function dateGroup(ts) {
  const t = ts * 1000;
  const today = startOfDay(Date.now());
  const en = EN();
  if (t >= today) return en ? "Today" : "今天";
  if (t >= today - DAY) return en ? "Yesterday" : "昨天";
  if (t >= today - 6 * DAY) return en ? "Last 7 days" : "最近 7 天";
  const now = new Date();
  const d = new Date(t);
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) return en ? "This month" : "本月";
  if (d.getFullYear() === now.getFullYear()) return en ? d.toLocaleString("en-US", { month: "long" }) : `${d.getMonth() + 1} 月`;
  return en ? String(d.getFullYear()) : `${d.getFullYear()} 年`;
}

export function fmtSize(n) {
  if (n >= 1073741824) return (n / 1073741824).toFixed(n >= 10737418240 ? 0 : 1).replace(/\.0$/, "") + " GB";
  if (n >= 1048576) return (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + " MB";
  if (n >= 1024) return Math.round(n / 1024) + " KB";
  return n + " B";
}

// 根据地址生成稳定的头像颜色
const PALETTE = ["#b8694a", "#b35a78", "#8e6bb8", "#5f6fc0", "#3f7fb5", "#3a8f9c", "#4a9a78", "#7a9648", "#b48a3a", "#8a7564"];
export function avatarColor(s) {
  let h = 0;
  for (const ch of String(s || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
export function initials(name, address) {
  const n = (name || address || "?").trim();
  const cjk = n.match(/[一-鿿]/g);
  if (cjk) return cjk[0];
  const parts = n.replace(/[<>"]/g, "").split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}
// 品牌头像：通过本站 /api/avatar 代取（浏览器不直接访问第三方），加载失败就保留首字母
const FREEMAIL = /^(gmail|googlemail|outlook|hotmail|live|msn|yahoo|ymail|icloud|me|mac|qq|foxmail|163|126|yeah|sina|sohu|aliyun|139|189|proton|protonmail|pm|gmx|mail|yandex|aol|zoho|naver|daum)\./;
const failedAvatars = new Set(JSON.parse(sessionStorage.getItem("cfm:avfail") || "[]"));
function brandDomain(address) {
  const d = (address || "").split("@")[1]?.toLowerCase();
  if (!d || FREEMAIL.test(d) || failedAvatars.has(d)) return null;
  return d;
}
export function avatar(name, address, size = "", { brand = true } = {}) {
  const d = brand ? brandDomain(address) : null;
  const img = d ? `<img class="av-img" src="/api/avatar/${encodeURIComponent(d)}" alt="" loading="lazy" decoding="async" data-dom="${esc(d)}" />` : "";
  return `<span class="avatar ${size}" style="--av:${avatarColor(address || name)}" aria-hidden="true">${esc(initials(name, address))}${img}</span>`;
}
// CSP 禁止内联事件，所以用全局捕获监听头像图片的加载结果
document.addEventListener(
  "load",
  (e) => e.target?.classList?.contains("av-img") && e.target.parentElement?.classList.add("has-img"),
  true,
);
document.addEventListener(
  "error",
  (e) => {
    const img = e.target;
    if (!img?.classList?.contains("av-img")) return;
    failedAvatars.add(img.dataset.dom);
    sessionStorage.setItem("cfm:avfail", JSON.stringify([...failedAvatars].slice(-500)));
    img.remove();
  },
  true,
);

// ---------- 时间预设（稍后提醒 / 定时发送） ----------
function at(daysFromNow, hour, minute = 0) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(hour, minute, 0, 0);
  return Math.floor(d.getTime() / 1000);
}
export function timePresets(kind = "snooze") {
  const n = new Date();
  const en = EN();
  const out = [{ label: en ? "In 1 hour" : "1 小时后", ts: Math.floor(Date.now() / 1000) + 3600 }];
  if (kind === "snooze" && n.getHours() < 17) out.push({ label: en ? "Later today" : "今天晚些时候", ts: at(0, 18) });
  out.push({ label: en ? "Tomorrow morning" : "明天上午", ts: at(1, 9) });
  out.push({ label: en ? "Tomorrow afternoon" : "明天下午", ts: at(1, 14) });
  const toMon = ((8 - n.getDay()) % 7) || 7;
  out.push({ label: en ? "Next Monday" : "下周一上午", ts: at(toMon, 9) });
  return out.map((p) => ({ ...p, hint: fmtWhen(p.ts) }));
}
export function fmtWhen(ts) {
  const d = new Date(ts * 1000);
  const today = startOfDay(Date.now());
  const day = startOfDay(d.getTime());
  const t = hm(d);
  const en = EN();
  if (day === today) return en ? `Today ${t}` : `今天 ${t}`;
  if (day === today + DAY) return en ? `Tomorrow ${t}` : `明天 ${t}`;
  if (day - today < 7 * DAY && day > today) return `${(en ? WEEK_EN : WEEK_ZH)[d.getDay()]} ${t}`;
  return en ? `${MONTH_EN[d.getMonth()]} ${d.getDate()} ${t}` : `${d.getMonth() + 1}月${d.getDate()}日 ${t}`;
}

export function fileKind(mime = "", name = "") {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (mime.startsWith("image/")) return { kind: "image", label: ext.toUpperCase() || "IMG" };
  if (mime === "application/pdf" || ext === "pdf") return { kind: "pdf", label: "PDF" };
  if (/zip|rar|7z|tar|gz/.test(mime + ext)) return { kind: "zip", label: ext.toUpperCase() || "ZIP" };
  if (/word|doc/.test(mime + ext)) return { kind: "doc", label: ext.toUpperCase() || "DOC" };
  if (/sheet|excel|xls|csv/.test(mime + ext)) return { kind: "xls", label: ext.toUpperCase() || "XLS" };
  if (/presentation|powerpoint|ppt|key/.test(mime + ext)) return { kind: "ppt", label: ext.toUpperCase() || "PPT" };
  if (/audio/.test(mime)) return { kind: "audio", label: ext.toUpperCase() || "AUDIO" };
  if (/video/.test(mime)) return { kind: "video", label: ext.toUpperCase() || "VIDEO" };
  if (/text|json|xml|html/.test(mime)) return { kind: "text", label: ext.toUpperCase() || "TXT" };
  return { kind: "file", label: (ext || "FILE").toUpperCase().slice(0, 4) };
}

export function linkify(escapedText) {
  return escapedText.replace(
    /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}，。；：！？）】])/g,
    (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`,
  );
}

// 纯文本正文：识别末尾的引用块，默认折叠
export function renderPlainText(text) {
  const lines = (text || "").replace(/\r\n/g, "\n").split("\n");
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const isHeader = /^(在.{2,80}写道[:：]|On .{4,200}wrote:|-{2,}\s*(原始邮件|Original Message|转发的邮件|Forwarded message)\s*-{2,})\s*$/i.test(l.trim());
    if (isHeader || (l.startsWith(">") && lines.slice(i).filter((x) => x.trim()).every((x) => x.startsWith(">")))) {
      cut = i;
      break;
    }
  }
  while (cut > 0 && !lines[cut - 1].trim() && cut < lines.length) cut--;
  const fmt = (ls) => linkify(esc(ls.join("\n")));
  const main = fmt(lines.slice(0, cut));
  const quoted = cut < lines.length ? fmt(lines.slice(cut)) : "";
  return { main, quoted };
}

export function plural(n, unit) {
  return `${n} ${unit}`;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const prefs = {
  get(key, def) {
    const v = localStorage.getItem("cfm:" + key);
    return v === null ? def : JSON.parse(v);
  },
  set(key, v) {
    localStorage.setItem("cfm:" + key, JSON.stringify(v));
  },
};
