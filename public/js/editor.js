// 富文本编辑器 + HTML 白名单过滤
// 编辑器运行在主页面里，任何放进去的 HTML（粘贴、引用原邮件、草稿）都必须先过滤，
// 否则 <img onerror> 之类的内容会在本站执行脚本。
import { icon } from "./icons.js";
import { promptDialog } from "./ui.js";
import { esc } from "./util.js";

const ALLOWED = new Set([
  "a", "b", "strong", "i", "em", "u", "s", "strike", "del", "br", "p", "div", "span", "ul", "ol", "li",
  "blockquote", "h1", "h2", "h3", "h4", "pre", "code", "hr", "sub", "sup", "small", "font",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "img", "center",
]);
const DROP = new Set(["script", "style", "iframe", "object", "embed", "head", "meta", "link", "form", "input", "button", "textarea", "select", "svg", "math", "template", "noscript", "title", "base", "frame", "frameset", "video", "audio", "canvas"]);
const STYLE_PROPS = new Set(["color", "background-color", "font-weight", "font-style", "text-decoration", "text-align", "font-size", "font-family", "line-height", "margin", "margin-left", "padding", "padding-left", "border-left", "list-style-type", "width", "max-width", "vertical-align"]);

function cleanStyle(style) {
  return style
    .split(";")
    .map((d) => d.trim())
    .filter((d) => {
      const [prop, ...rest] = d.split(":");
      const val = rest.join(":").toLowerCase();
      return prop && STYLE_PROPS.has(prop.trim().toLowerCase()) && !/url\s*\(|expression|javascript:|@import|behavior/.test(val);
    })
    .join("; ");
}

function cleanNode(node, doc) {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === Node.COMMENT_NODE) {
      child.remove();
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = child.tagName.toLowerCase();
    if (DROP.has(tag)) {
      child.remove();
      continue;
    }
    cleanNode(child, doc);
    if (!ALLOWED.has(tag)) {
      child.replaceWith(...child.childNodes);
      continue;
    }
    for (const attr of [...child.attributes]) {
      const name = attr.name.toLowerCase();
      const val = attr.value;
      let keep = false;
      if (name === "href" && tag === "a") keep = /^(https?:|mailto:)/i.test(val.trim());
      else if (name === "src" && tag === "img") keep = /^(data:image\/(png|jpe?g|gif|webp);|\/api\/)/i.test(val.trim());
      else if (name === "style") {
        const s = cleanStyle(val);
        if (s) child.setAttribute("style", s);
        keep = Boolean(s);
        if (keep) continue;
      } else keep = ["alt", "title", "colspan", "rowspan", "align", "width", "height", "color", "face", "size", "valign", "cellpadding", "cellspacing", "border"].includes(name) || (name === "class" && /^(signature|cfm-quote|cfm-quote-head)$/.test(val));
      if (!keep) child.removeAttribute(attr.name);
    }
    if (tag === "a") {
      child.setAttribute("target", "_blank");
      child.setAttribute("rel", "noopener noreferrer");
    }
  }
}

// DOMParser 生成的是惰性文档：脚本不会执行、图片不会加载，可以安全地在里面过滤
export function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}`, "text/html");
  cleanNode(doc.body, doc);
  return doc.body.innerHTML;
}

export const textToHtml = (t) =>
  esc(t || "")
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");

const TOOLS = [
  { cmd: "bold", icon: "bold", title: "粗体 (⌘B)" },
  { cmd: "italic", icon: "italic", title: "斜体 (⌘I)" },
  { cmd: "underline", icon: "underline", title: "下划线 (⌘U)" },
  { cmd: "strikeThrough", icon: "strike", title: "删除线" },
  "|",
  { cmd: "link", icon: "link", title: "插入链接 (⌘K)" },
  { cmd: "insertUnorderedList", icon: "list", title: "项目符号列表" },
  { cmd: "insertOrderedList", icon: "listOrdered", title: "编号列表" },
  { cmd: "quote", icon: "quote", title: "引用" },
  "|",
  { cmd: "removeFormat", icon: "eraser", title: "清除格式" },
];

export function createEditor({ html = "", placeholder = "", onChange, onFiles }) {
  const wrap = document.createElement("div");
  wrap.className = "editor";
  wrap.innerHTML = `
    <div class="editor-toolbar" role="toolbar" aria-label="格式">
      ${TOOLS.map((t) => (t === "|" ? `<span class="tb-sep"></span>` : `<button type="button" class="tb-btn" data-cmd="${t.cmd}" title="${t.title}" aria-label="${t.title}">${icon(t.icon)}</button>`)).join("")}
    </div>
    <div class="editor-area" contenteditable="true" role="textbox" aria-multiline="true" aria-label="${esc(placeholder || "正文")}" data-placeholder="${esc(placeholder)}"></div>`;
  const area = wrap.querySelector(".editor-area");
  area.innerHTML = sanitizeHtml(html);
  const changed = () => {
    area.classList.toggle("empty", !area.textContent.trim() && !area.querySelector("img"));
    onChange?.();
  };
  changed();

  const exec = async (cmd) => {
    area.focus();
    if (cmd === "link") {
      const sel = window.getSelection();
      const range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
      const url = await promptDialog({ title: "插入链接", label: "链接地址", placeholder: "https://", value: "https://" });
      if (!url || !/^(https?:\/\/|mailto:)/i.test(url.trim())) return;
      area.focus();
      if (range) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
      if (range && !range.collapsed) document.execCommand("createLink", false, url.trim());
      else document.execCommand("insertHTML", false, `<a href="${esc(url.trim())}">${esc(url.trim())}</a>`);
    } else if (cmd === "quote") {
      document.execCommand("formatBlock", false, "blockquote");
    } else {
      document.execCommand(cmd, false);
    }
    changed();
    updateState();
  };
  wrap.querySelectorAll(".tb-btn").forEach((b) => {
    b.addEventListener("mousedown", (e) => e.preventDefault()); // 保持选区
    b.addEventListener("click", () => exec(b.dataset.cmd));
  });

  const updateState = () => {
    for (const cmd of ["bold", "italic", "underline", "strikeThrough", "insertUnorderedList", "insertOrderedList"]) {
      let on = false;
      try {
        on = document.queryCommandState(cmd);
      } catch {}
      wrap.querySelector(`[data-cmd="${cmd}"]`)?.classList.toggle("on", on);
    }
  };
  document.addEventListener("selectionchange", () => {
    if (document.activeElement === area) updateState();
  });

  area.addEventListener("input", changed);
  // 点击正文空白处时，如果下面是签名或引用，把光标放到开头的空行，而不是签名后面
  area.addEventListener("mousedown", (e) => {
    if (e.target !== area) return;
    const tail = area.querySelector(":scope > .signature, :scope > .cfm-quote");
    const first = area.firstElementChild;
    if (!tail || !first || first === tail || first.textContent.trim()) return;
    e.preventDefault();
    area.focus();
    const r = document.createRange();
    r.setStart(first, 0);
    r.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  });
  area.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      exec("link");
    }
  });
  area.addEventListener("paste", (e) => {
    const dt = e.clipboardData;
    if (!dt) return;
    const files = [...dt.files];
    if (files.length) {
      e.preventDefault();
      onFiles?.(files);
      return;
    }
    const html = dt.getData("text/html");
    e.preventDefault();
    if (html) document.execCommand("insertHTML", false, sanitizeHtml(html));
    else document.execCommand("insertText", false, dt.getData("text/plain"));
    changed();
  });
  // 拖进来的文件交给附件处理，不要让浏览器把图片直接插进正文
  area.addEventListener("drop", (e) => {
    if (e.dataTransfer?.files?.length) {
      e.preventDefault();
      onFiles?.([...e.dataTransfer.files]);
    }
  });

  return {
    el: wrap,
    area,
    getHtml: () => sanitizeHtml(area.innerHTML),
    getText: () => area.innerText.replace(/ /g, " ").replace(/\n{3,}/g, "\n\n").trim(),
    setHtml(h) {
      area.innerHTML = sanitizeHtml(h);
      changed();
    },
    isEmpty: () => !area.textContent.trim(),
    focus(atStart = true) {
      area.focus();
      const r = document.createRange();
      r.selectNodeContents(area);
      r.collapse(atStart);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
    },
  };
}
