// 界面翻译：英文模式下，把应用自身的界面文字（不含邮件内容）替换成英文。
// 采用运行时翻译：监听 DOM 变化，按词典替换文本节点和 title / placeholder / aria-label。
import { lang } from "./util.js";

let EXACT = null;
let PATTERNS = [];
const HAS_CJK = /[㐀-鿿]/;
// 邮件内容、人名、主题等用户数据不翻译
const SKIP = ".msg-body, .row-subject, .row-snippet, .editor-area, .thread-subject, .ai-body, .msg-snippet, .sugg, .chip-addr, .att-name, .lb-name, .addr-main b, .msg-name, .row-from, .dc-title b, code, kbd, [data-no-i18n]";
const ATTRS = ["title", "placeholder", "aria-label", "data-placeholder"];

function tr(value) {
  if (!value || !HAS_CJK.test(value)) return null;
  const t = value.trim();
  let out = EXACT[t];
  if (out === undefined) {
    for (const [re, rep] of PATTERNS) {
      re.lastIndex = 0;
      if (re.test(t)) {
        re.lastIndex = 0;
        out = t.replace(re, rep);
        break;
      }
    }
  }
  if (out === undefined || out === t) return null;
  return value.replace(t, out);
}

function skipped(el) {
  const skip = el.closest(SKIP);
  if (!skip) return false;
  const allow = el.closest(".i18n");
  return !(allow && skip.contains(allow));
}

function translateText(node) {
  const p = node.parentElement;
  if (!p || skipped(p) || p.closest("script, style, textarea")) return;
  const out = tr(node.nodeValue);
  if (out !== null) node.nodeValue = out;
}

function translateAttrs(el) {
  if (!el.closest || el.closest("[data-no-i18n]")) return;
  for (const a of ATTRS) {
    const v = el.getAttribute?.(a);
    if (!v) continue;
    const out = tr(v);
    if (out !== null) el.setAttribute(a, out);
  }
}

function translateTree(root) {
  if (root.nodeType === Node.TEXT_NODE) return translateText(root);
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  translateAttrs(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    if (n.nodeType === Node.TEXT_NODE) translateText(n);
    else translateAttrs(n);
  }
}

function translateTitle() {
  // "(3) 收件箱 · CleanTempMail Workspace"
  const m = document.title.match(/^(\(\d+\) )?(.*?)( · CleanTempMail Workspace)$/);
  if (!m || !HAS_CJK.test(m[2])) return;
  const out = tr(m[2]);
  if (out !== null) document.title = `${m[1] ?? ""}${out}${m[3]}`;
}

export async function initI18n() {
  const l = lang();
  document.documentElement.lang = l === "en" ? "en" : "zh-CN";
  if (l !== "en") return;
  try {
    const dict = await import("./i18n-dict.js");
    EXACT = dict.EXACT;
    PATTERNS = dict.PATTERNS;
  } catch (e) {
    console.warn("i18n dictionary missing", e);
    return;
  }
  translateTree(document.body);
  translateTitle();
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === "childList") m.addedNodes.forEach(translateTree);
      else if (m.type === "characterData") translateText(m.target);
      else if (m.type === "attributes") translateAttrs(m.target);
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  const title = document.querySelector("title");
  if (title) new MutationObserver(translateTitle).observe(title, { childList: true, characterData: true, subtree: true });
}

// 给 confirm()/toast 之类直接用字符串的地方用
export const t = (s) => (EXACT ? tr(s) ?? s : s);
