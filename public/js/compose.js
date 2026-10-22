// 写信窗口：浮动窗口、收件人补全、附件上传、草稿自动保存、撤销发送、签名
import { api, uploadFile } from "./api.js";
import { createEditor, sanitizeHtml, textToHtml } from "./editor.js";
import { icon } from "./icons.js";
import { emit, navigate, store } from "./store.js";
import { confirmDialog, menu, pickDateTime, promptDialog, toast, toastError } from "./ui.js";
import { debounce, esc, fileKind, fmtSize, fmtWhen, isEmail, parseList, prefs, timePresets } from "./util.js";

// ---------- 收件人输入框（地址胶囊 + 自动补全） ----------
function parseAddress(raw) {
  const s = raw.trim().replace(/^[,;，；]+|[,;，；]+$/g, "");
  if (!s) return null;
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim(), address: m[2].trim().toLowerCase() };
  return { name: "", address: s.toLowerCase() };
}

class RecipientField {
  constructor(el, values = [], onChange) {
    this.el = el;
    this.onChange = onChange;
    this.chips = [];
    el.classList.add("rcpt");
    el.innerHTML = `<input class="rcpt-input" type="text" autocomplete="off" spellcheck="false" />`;
    this.input = el.querySelector("input");
    el.addEventListener("mousedown", (e) => {
      if (e.target === el) {
        e.preventDefault();
        this.input.focus();
      }
    });
    values.forEach((v) => this.add(typeof v === "string" ? parseAddress(v) : v, false));
    this.bind();
  }
  bind() {
    const inp = this.input;
    inp.addEventListener("keydown", (e) => {
      if (this.sugg && ["ArrowDown", "ArrowUp"].includes(e.key)) {
        e.preventDefault();
        this.moveSugg(e.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (["Enter", "Tab", ",", ";", "，", "；"].includes(e.key) || (e.key === " " && isEmail(inp.value.trim()))) {
        if (this.sugg && this.suggIndex >= 0 && (e.key === "Enter" || e.key === "Tab")) {
          e.preventDefault();
          this.pick(this.suggItems[this.suggIndex]);
          return;
        }
        if (inp.value.trim()) {
          e.preventDefault();
          this.commit();
        }
      } else if (e.key === "Backspace" && !inp.value && this.chips.length) {
        this.remove(this.chips.length - 1);
      } else if (e.key === "Escape" && this.sugg) {
        e.stopPropagation();
        this.closeSugg();
      }
    });
    inp.addEventListener("input", debounce(() => this.suggest(), 120));
    inp.addEventListener("paste", (e) => {
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (/[,;，；\n]/.test(text) || (text.match(/@/g) ?? []).length > 1) {
        e.preventDefault();
        text.split(/[,;，；\n]+/).forEach((t) => this.add(parseAddress(t)));
      }
    });
    inp.addEventListener("blur", () =>
      setTimeout(() => {
        if (document.activeElement !== inp) {
          if (inp.value.trim()) this.commit();
          this.closeSugg();
        }
      }, 150),
    );
  }
  commit() {
    this.input.value.split(/[,;，；]+/).forEach((t) => this.add(parseAddress(t)));
    this.input.value = "";
    this.closeSugg();
  }
  add(a, notify = true) {
    if (!a?.address || this.chips.some((c) => c.address === a.address)) return;
    this.chips.push(a);
    const chip = document.createElement("span");
    chip.className = "chip-addr" + (isEmail(a.address) ? "" : " invalid");
    chip.title = a.address;
    chip.innerHTML = `<span>${esc(a.name || a.address)}</span><button type="button" tabindex="-1" aria-label="移除">${icon("x")}</button>`;
    chip.querySelector("button").onclick = () => this.remove(this.chips.indexOf(a));
    chip.addEventListener("dblclick", () => {
      const i = this.chips.indexOf(a);
      this.remove(i);
      this.input.value = a.name ? `${a.name} <${a.address}>` : a.address;
      this.input.focus();
    });
    this.el.insertBefore(chip, this.input);
    if (notify) this.onChange?.();
  }
  remove(i) {
    if (i < 0) return;
    this.chips.splice(i, 1);
    this.el.querySelectorAll(".chip-addr")[i]?.remove();
    this.onChange?.();
  }
  values() {
    if (this.input.value.trim()) this.commit();
    return this.chips.map((c) => c.address);
  }
  invalid() {
    return this.chips.filter((c) => !isEmail(c.address)).map((c) => c.address);
  }
  async suggest() {
    const q = this.input.value.trim();
    if (q.length < 1) return this.closeSugg();
    try {
      const items = (await api(`/contacts?q=${encodeURIComponent(q)}`)).filter((x) => !this.chips.some((c) => c.address === x.address));
      if (!items.length || this.input.value.trim() !== q) return this.closeSugg();
      this.showSugg(items);
    } catch {
      this.closeSugg();
    }
  }
  showSugg(items) {
    this.closeSugg();
    this.suggItems = items;
    this.suggIndex = 0;
    const box = document.createElement("div");
    box.className = "sugg";
    box.innerHTML = items
      .map(
        (x, i) => `<button type="button" class="sugg-item ${i === 0 ? "active" : ""}" data-i="${i}">
        <span class="sugg-name">${esc(x.name || x.address.split("@")[0])}</span><span class="sugg-addr">${esc(x.address)}</span></button>`,
      )
      .join("");
    box.addEventListener("mousedown", (e) => {
      const b = e.target.closest(".sugg-item");
      if (b) {
        e.preventDefault();
        this.pick(items[Number(b.dataset.i)]);
      }
    });
    this.el.appendChild(box);
    this.sugg = box;
  }
  moveSugg(d) {
    this.suggIndex = (this.suggIndex + d + this.suggItems.length) % this.suggItems.length;
    this.sugg.querySelectorAll(".sugg-item").forEach((b, i) => b.classList.toggle("active", i === this.suggIndex));
  }
  pick(item) {
    this.add({ name: item.name || "", address: item.address });
    this.input.value = "";
    this.closeSugg();
    this.input.focus();
  }
  closeSugg() {
    this.sugg?.remove();
    this.sugg = null;
  }
}

// ---------- 身份与签名 ----------
export function resolveIdentity(address) {
  const a = (address || "").toLowerCase();
  const d = "@" + a.split("@")[1];
  const ids = store.identities;
  const pick = (k) => ids.find((x) => x.address === k);
  const exact = pick(a);
  const dom = pick(d);
  const all = pick("*");
  return {
    name: exact?.name || dom?.name || all?.name || "",
    signature: exact?.signature ?? dom?.signature ?? all?.signature ?? "",
  };
}

function knownAddresses() {
  const set = new Set(store.stats.mailboxes.map((m) => m.mailbox));
  store.identities.forEach((i) => i.address.includes("@") && !i.address.startsWith("@") && set.add(i.address));
  return [...set].filter((a) => store.domains.some((d) => a.endsWith("@" + d.name)));
}

// ---------- 写信窗口 ----------
let current = null; // 当前打开的窗口

export function hasOpenComposer() {
  return Boolean(current);
}
// 有用户改过、但还没保存成草稿的内容
export const composerHasUnsaved = () => Boolean(current?.touched && current.dirty);

// opts.mount：嵌入到阅读区底部的回复框（宽屏）；否则是浮动窗口
export async function openComposer(prefill = {}, opts = {}) {
  prefill = (await prefill) ?? {};
  if (!store.domains.length) {
    toast("请先在「域名管理」中添加域名", { type: "error" });
    return;
  }
  if (current) {
    if (current.state.draftId === prefill.draftId && prefill.draftId) {
      current.restore();
      return;
    }
    await current.close({ save: true, quiet: true });
  }
  // 回复方式可在设置里改成弹出窗口
  const mount = opts.mount?.isConnected && innerWidth >= 760 && prefs.get("replyMode", "window") === "inline" ? opts.mount : null;
  current = new Composer(prefill, { mount });
}

// 阅读区重新渲染后，把内嵌的回复框放回新的位置（同一会话）；
// 换了会话、或阅读区要隐藏（slot 为 null）时，写过内容的转成浮动窗口，没写过的直接收起
export function reattachInline(slot, threadId) {
  if (!current?.mount) return;
  if (slot && current.el.parentElement === slot) return;
  if (slot && current.threadId && current.threadId === threadId) {
    slot.appendChild(current.el);
    current.mount = slot;
    return;
  }
  if (current.touched && !current.isEmpty()) current.popOut();
  else current.destroy();
}
// 阅读区被整个替换（例如切到设置页）时也不能丢掉正在写的回复
new MutationObserver(() => {
  if (current?.mount && !current.el.isConnected) queueMicrotask(() => reattachInline(null, null));
}).observe(document.documentElement, { childList: true, subtree: true });

class Composer {
  constructor(p, { mount = null } = {}) {
    this.mount = mount;
    this.threadId = p.threadId || null;
    this.state = {
      draftId: p.draftId || crypto.randomUUID(),
      replyToId: p.replyToId || null,
      attachments: (p.attachments || []).map((a) => ({ ...a, key: crypto.randomUUID(), status: "done" })),
    };
    this.dirty = false;
    this.touched = false; // 用户是否真的改过：没改过的窗口关闭时不存草稿、舍弃时不确认
    this.savedAt = p.updated_at || null;
    this.ready = false;
    this.autosave = debounce(() => this.saveDraft(), 1500);
    this.build(p);
    this.ready = true;
  }

  build(p) {
    const sendable = store.domains;
    const defaultFrom =
      p.from ||
      knownAddresses().find((a) => store.domains.some((d) => a.endsWith("@" + d.name) && d.send_provider !== "none")) ||
      "hello@" + (sendable.find((d) => d.send_provider !== "none") || sendable[0]).name;
    const at = defaultFrom.lastIndexOf("@");
    const local = defaultFrom.slice(0, at);
    const domain = defaultFrom.slice(at + 1);
    const ident = resolveIdentity(defaultFrom);
    this.fromName = p.fromName ?? ident.name;

    const el = document.createElement("section");
    el.className = "composer" + (this.mount ? " inline" : innerWidth < 760 ? " maximized" : "");
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "写邮件");
    el.innerHTML = `
      <header class="composer-head">
        <span class="composer-title">${esc(p.subject || (p.replyToId ? "回复" : "新邮件"))}</span>
        <div class="composer-head-actions">
          <button class="icon-btn sm" data-act="popout" title="在独立窗口中编辑" aria-label="在独立窗口中编辑">${icon("external")}</button>
          <button class="icon-btn sm" data-act="min" title="最小化 (Esc)" aria-label="最小化">${icon("minimize")}</button>
          <button class="icon-btn sm" data-act="max" title="展开" aria-label="展开">${icon("maximize")}</button>
          <button class="icon-btn sm" data-act="close" title="保存并关闭" aria-label="关闭窗口">${icon("x")}</button>
        </div>
      </header>
      <div class="composer-body">
        <div class="c-row c-from">
          <label>发件人</label>
          <div class="from-fields">
            <button type="button" class="from-name" title="修改显示名"></button>
            <span class="from-addr"><input class="from-local" value="${esc(local)}" spellcheck="false" aria-label="发件地址名" placeholder="任意名称" />
            <span class="from-at">@</span>
            <select class="from-domain" aria-label="发件域名">${store.domains
              .map((d) => `<option value="${esc(d.name)}" ${d.name === domain ? "selected" : ""}>${esc(d.name)}${d.send_provider === "none" ? "（未开通发件）" : ""}</option>`)
              .join("")}</select></span>
            <button type="button" class="icon-btn sm from-pick" title="常用地址" aria-label="常用地址">${icon("chevronDown")}</button>
          </div>
        </div>
        <div class="c-row"><label>收件人</label><div data-field="to"></div>
          <div class="row-extra"><button type="button" class="link-btn" data-show="cc">抄送</button><button type="button" class="link-btn" data-show="bcc">密送</button></div></div>
        <div class="c-row" data-row="cc" hidden><label>抄送</label><div data-field="cc"></div></div>
        <div class="c-row" data-row="bcc" hidden><label>密送</label><div data-field="bcc"></div></div>
        <div class="c-row c-subject"><input class="subject" placeholder="主题" value="${esc(p.subject || "")}" aria-label="主题" /></div>
        <div class="send-warn"></div>
        <div class="editor-slot"></div>
        <button type="button" class="inline-quote-toggle" title="显示引用内容" aria-label="显示引用内容" aria-pressed="false">${icon("moreH")}</button>
        <div class="c-attachments"></div>
      </div>
      <footer class="composer-foot">
        <div class="send-group">
          <button class="btn primary send-btn" title="发送 (⌘/Ctrl + Enter)">${icon("send")}<span>发送</span></button>
          <button class="btn primary send-more" title="定时发送" aria-label="定时发送">${icon("chevronDown")}</button>
        </div>
        <button class="icon-btn" data-act="attach" title="添加附件" aria-label="添加附件">${icon("paperclip")}</button>
        <button class="icon-btn" data-act="templates" title="模板" aria-label="模板">${icon("template")}</button>
        ${store.me.ai && p.replyToId ? `<button class="icon-btn" data-act="ai" title="AI 起草回复" aria-label="AI 起草回复">${icon("wand")}</button>` : ""}
        <input type="file" class="file-input" multiple tabindex="-1" aria-hidden="true" />
        <span class="size-meter"></span>
        <span class="draft-status"></span>
        <button class="icon-btn danger-hover" data-act="discard" title="舍弃草稿" aria-label="舍弃草稿">${icon("trash")}</button>
      </footer>
      <div class="drop-overlay">${icon("upload")}<span>松开即可添加附件</span></div>`;
    (this.mount || document.body).appendChild(el);
    this.el = el;
    const q = (s) => el.querySelector(s);

    const mark = () => this.markDirty();
    this.to = new RecipientField(q('[data-field="to"]'), p.to || [], mark);
    this.cc = new RecipientField(q('[data-field="cc"]'), p.cc || [], mark);
    this.bcc = new RecipientField(q('[data-field="bcc"]'), p.bcc || [], mark);
    if ((p.cc || []).length) this.showRow("cc");
    if ((p.bcc || []).length) this.showRow("bcc");

    // 正文：草稿原文 / 新邮件（签名） / 回复（签名 + 引用）
    let html = p.html;
    if (html === undefined) {
      const sig = ident.signature ? `<div class="signature">${sanitizeHtml(ident.signature)}</div>` : "";
      html = `<p><br></p>${sig ? "<p><br></p>" + sig : ""}${p.quoteHtml || ""}`;
    }
    this.editor = createEditor({ html, placeholder: "正文", onChange: mark, onFiles: (files) => this.addFiles(files) });
    q(".editor-slot").appendChild(this.editor.el);
    // 内嵌回复时引用原文默认折叠（发送时仍然包含完整引用）
    el.classList.toggle("has-quote", Boolean(p.quoteHtml));
    q(".inline-quote-toggle").onclick = (e) => {
      const on = el.classList.toggle("show-quote");
      e.currentTarget.setAttribute("aria-pressed", String(on));
      if (this.mount) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    };

    this.renderFromName();
    this.renderAttachments();
    this.updateWarn();
    this.updateDraftStatus();

    // 事件
    q('[data-act="min"]').onclick = () => this.toggleMin();
    q(".composer-head").addEventListener("dblclick", (e) => !e.target.closest("button") && this.toggleMin());
    q(".composer-title").onclick = () => this.el.classList.contains("minimized") && this.toggleMin();
    q('[data-act="max"]').onclick = () => this.toggleMax();
    q('[data-act="popout"]').onclick = () => this.popOut();
    q('[data-act="close"]').onclick = () => this.close({ save: true });
    q('[data-act="discard"]').onclick = () => this.discard();
    q('[data-act="attach"]').onclick = () => q(".file-input").click();
    q(".file-input").onchange = (e) => {
      this.addFiles([...e.target.files]);
      e.target.value = "";
    };
    el.querySelectorAll("[data-show]").forEach((b) => (b.onclick = () => this.showRow(b.dataset.show, true)));
    q(".subject").addEventListener("input", () => {
      q(".composer-title").textContent = q(".subject").value || "新邮件";
      mark();
    });
    q(".from-local").addEventListener("input", () => this.fromChanged());
    q(".from-domain").addEventListener("change", () => this.fromChanged());
    q(".from-name").onclick = () => this.editFromName();
    q(".from-pick").onclick = (e) => this.pickFrom(e.currentTarget);
    q(".send-btn").onclick = () => this.send();
    q(".send-more").onclick = (e) => this.scheduleMenu(e.currentTarget);
    q('[data-act="templates"]').onclick = (e) => this.templatesMenu(e.currentTarget);
    q('[data-act="ai"]')?.addEventListener("click", () => this.aiDraft());
    this.sizeLocal();
    q(".from-local").addEventListener("input", () => this.sizeLocal());
    el.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        this.send();
      } else if (e.key === "Escape" && !this.mount && !document.querySelector(".modal-backdrop") && !el.querySelector(".sugg")) {
        e.preventDefault();
        this.toggleMin(true);
      }
    });

    // 拖拽添加附件
    let dragDepth = 0;
    el.addEventListener("dragenter", (e) => {
      if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
      e.preventDefault();
      dragDepth++;
      el.classList.add("dragging");
    });
    el.addEventListener("dragover", (e) => {
      if ([...(e.dataTransfer?.types || [])].includes("Files")) e.preventDefault();
    });
    el.addEventListener("dragleave", () => {
      if (--dragDepth <= 0) {
        dragDepth = 0;
        el.classList.remove("dragging");
      }
    });
    el.addEventListener("drop", (e) => {
      dragDepth = 0;
      el.classList.remove("dragging");
      if (e.dataTransfer?.files?.length) {
        e.preventDefault();
        this.addFiles([...e.dataTransfer.files]);
      }
    });

    requestAnimationFrame(() => {
      el.classList.add("show");
      if (p.replyToId || p.focus === "body") this.editor.focus(true);
      else if (!this.to.chips.length) this.to.input.focus();
      else q(".subject").focus();
    });
  }

  // ---- 发件人 ----
  get from() {
    return `${this.el.querySelector(".from-local").value.trim().toLowerCase()}@${this.el.querySelector(".from-domain").value}`;
  }
  fromChanged() {
    const ident = resolveIdentity(this.from);
    if (!this.customName) this.fromName = ident.name;
    this.renderFromName();
    // 切换签名
    const sigEl = this.editor.area.querySelector(".signature");
    if (sigEl) {
      if (ident.signature) sigEl.innerHTML = sanitizeHtml(ident.signature);
      else sigEl.remove();
    } else if (ident.signature) {
      const quote = this.editor.area.querySelector(".cfm-quote");
      const div = document.createElement("div");
      div.className = "signature";
      div.innerHTML = sanitizeHtml(ident.signature);
      this.editor.area.insertBefore(div, quote);
    }
    this.updateWarn();
    this.markDirty();
  }
  renderFromName() {
    const el = this.el.querySelector(".from-name");
    el.innerHTML = this.fromName ? `${esc(this.fromName)}` : `<span class="muted">添加显示名</span>`;
  }
  async editFromName() {
    const v = await promptDialog({ title: "发件人显示名", label: "收件人会看到这个名字", value: this.fromName, placeholder: "例如：张三 / 销售部" });
    if (v === null) return;
    this.fromName = v.trim();
    this.customName = true;
    this.renderFromName();
    this.markDirty();
  }
  pickFrom(anchor) {
    const addrs = knownAddresses();
    menu(
      anchor,
      [
        { header: "常用地址" },
        ...(addrs.length ? addrs : ["（还没有）"]).map((a) =>
          typeof a === "string" && a.includes("@")
            ? {
                label: a,
                icon: "at",
                active: a === this.from,
                onClick: () => {
                  const at = a.lastIndexOf("@");
                  this.el.querySelector(".from-local").value = a.slice(0, at);
                  this.el.querySelector(".from-domain").value = a.slice(at + 1);
                  this.customName = false;
                  this.fromChanged();
                },
              }
            : { label: a, disabled: true },
        ),
      ],
      { align: "left" },
    );
  }
  domainRow() {
    return store.domains.find((d) => d.name === this.el.querySelector(".from-domain").value);
  }
  limit() {
    const d = this.domainRow();
    return (d && store.me.limits?.[d.send_provider]) || 5 * 1024 * 1024;
  }
  updateWarn() {
    const d = this.domainRow();
    const box = this.el.querySelector(".send-warn");
    if (d?.send_provider === "none") {
      box.innerHTML = `<div class="notice warn sm">${icon("alert")}<span>@${esc(d.name)} 还没有开通发件服务。<a href="#/domains">去开通</a></span></div>`;
    } else if (d?.send_status === "pending") {
      box.innerHTML = `<div class="notice info sm">${icon("info")}<span>@${esc(d.name)} 的发件 DNS 仍在验证中，可能暂时发不出去。</span></div>`;
    } else box.innerHTML = "";
    this.updateSize();
  }

  showRow(name, focus = false) {
    this.el.querySelector(`[data-row="${name}"]`).hidden = false;
    this.el.querySelector(`[data-show="${name}"]`).hidden = true;
    if (focus) this[name].input.focus();
  }

  // ---- 附件 ----
  addFiles(files) {
    this.touched = true;
    for (const file of files) {
      const att = { key: crypto.randomUUID(), filename: file.name || "file", size: file.size, type: file.type || "application/octet-stream", status: "uploading", progress: 0 };
      if (file.size > 25 * 1024 * 1024) {
        toast(`「${att.filename}」超过 25 MB，无法添加`, { type: "error" });
        continue;
      }
      this.state.attachments.push(att);
      const up = uploadFile(file, (p) => {
        att.progress = p;
        const bar = this.el.querySelector(`[data-key="${att.key}"] .att-progress > i`);
        if (bar) bar.style.width = Math.round(p * 100) + "%";
      });
      att.abort = up.abort;
      up.then((r) => {
        att.uploadId = r.id;
        att.status = "done";
        delete att.abort;
        this.renderAttachments();
        this.markDirty();
      }).catch((e) => {
        if (e.code === "aborted") return;
        att.status = "error";
        att.error = e.message;
        this.renderAttachments();
      });
    }
    this.renderAttachments();
  }
  removeAttachment(key) {
    const i = this.state.attachments.findIndex((a) => a.key === key);
    if (i < 0) return;
    const [a] = this.state.attachments.splice(i, 1);
    a.abort?.();
    if (a.uploadId) api(`/uploads/${a.uploadId}`, { method: "DELETE" }).catch(() => {});
    this.renderAttachments();
    this.markDirty();
  }
  renderAttachments() {
    const box = this.el.querySelector(".c-attachments");
    box.innerHTML = this.state.attachments
      .map((a) => {
        const k = fileKind(a.type, a.filename);
        return `<div class="att-chip ${a.status}" data-key="${a.key}" title="${esc(a.error || a.filename)}">
          <span class="ficon f-${k.kind}">${esc(k.label)}</span>
          <span class="att-meta"><span class="att-name">${esc(a.filename)}</span>
            <span class="att-size">${a.status === "error" ? esc(a.error || "上传失败") : a.status === "uploading" ? "上传中…" : fmtSize(a.size)}</span></span>
          ${a.status === "uploading" ? `<span class="att-progress"><i style="width:${Math.round((a.progress || 0) * 100)}%"></i></span>` : ""}
          <button type="button" class="icon-btn xs" aria-label="移除附件">${icon("x")}</button>
        </div>`;
      })
      .join("");
    box.querySelectorAll(".att-chip").forEach((c) => (c.querySelector("button").onclick = () => this.removeAttachment(c.dataset.key)));
    this.updateSize();
  }
  totalSize() {
    return this.state.attachments.filter((a) => a.status !== "error").reduce((s, a) => s + a.size, 0);
  }
  updateSize() {
    const meter = this.el.querySelector(".size-meter");
    const total = this.totalSize();
    if (!total) {
      meter.textContent = "";
      return;
    }
    const encoded = total * 1.37;
    const limit = this.limit();
    meter.textContent = `${fmtSize(total)} / ${fmtSize(limit / 1.37)}`;
    meter.classList.toggle("over", encoded > limit);
    meter.title = encoded > limit ? "附件超过当前发件服务的大小上限" : "附件总大小（上限已按编码后的体积换算）";
  }

  // ---- 草稿 ----
  markDirty() {
    if (!this.ready) return; // 初始化期间编辑器触发的变化不算修改
    this.dirty = true;
    this.touched = true;
    this.updateDraftStatus("editing");
    this.autosave();
  }
  isEmpty() {
    return !this.to.chips.length && !this.cc.chips.length && !this.bcc.chips.length && !this.el.querySelector(".subject").value.trim() && this.editor.isEmpty() && !this.state.attachments.length;
  }
  payload() {
    return {
      from: this.from,
      fromName: this.fromName,
      to: this.to.values(),
      cc: this.cc.values(),
      bcc: this.bcc.values(),
      subject: this.el.querySelector(".subject").value,
      html: this.editor.getHtml(),
      text: this.editor.getText(),
      replyToId: this.state.replyToId,
      attachments: this.state.attachments
        .filter((a) => a.status === "done")
        .map((a) => (a.uploadId ? { uploadId: a.uploadId, filename: a.filename, size: a.size, type: a.type } : { messageId: a.messageId, index: a.index, filename: a.filename, size: a.size, type: a.type })),
    };
  }
  async saveDraft({ force = false } = {}) {
    if (!this.dirty || (!force && !this.el?.isConnected)) return;
    if (!this.touched || this.isEmpty()) return;
    this.dirty = false;
    this.updateDraftStatus("saving");
    try {
      const r = await api(`/drafts/${this.state.draftId}`, { method: "PUT", body: this.payload() });
      this.savedAt = r.updated_at;
      this.updateDraftStatus();
      emit("drafts:changed");
    } catch (e) {
      this.dirty = true;
      this.updateDraftStatus("error");
    }
  }
  updateDraftStatus(state) {
    const el = this.el.querySelector(".draft-status");
    if (state === "saving") el.textContent = "正在保存…";
    else if (state === "error") el.textContent = "草稿保存失败";
    else if (state === "editing") el.textContent = "";
    else el.textContent = this.savedAt ? `草稿已保存 ${new Date(this.savedAt * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` : "";
  }

  // ---- 窗口 ----
  toggleMin(force) {
    const min = force ?? !this.el.classList.contains("minimized");
    this.el.classList.toggle("minimized", min);
    if (min) this.el.classList.remove("maximized");
  }
  toggleMax() {
    const max = !this.el.classList.contains("maximized");
    this.el.classList.toggle("maximized", max);
    this.el.classList.remove("minimized");
    this.el.querySelector('[data-act="max"]').innerHTML = icon(max ? "minimize2" : "maximize");
  }
  restore() {
    this.el.classList.remove("minimized");
  }
  // 内嵌回复框 → 浮动窗口
  popOut() {
    if (!this.mount) return;
    this.mount = null;
    this.el.classList.remove("inline");
    if (innerWidth < 760) this.el.classList.add("maximized");
    document.body.appendChild(this.el);
    this.el.classList.add("show");
  }
  async close({ save = true, quiet = false } = {}) {
    if (save && this.touched && !this.isEmpty()) {
      // 还有附件在上传：等它们完成再存草稿，否则草稿里会缺附件
      const pending = this.state.attachments.filter((a) => a.status === "uploading");
      if (pending.length) {
        this.el.classList.add("closing");
        const t = toast(`正在等待 ${pending.length} 个附件上传完成…`, { type: "loading", duration: 0 });
        const deadline = Date.now() + 120000;
        while (this.state.attachments.some((a) => a.status === "uploading") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300));
        t.close();
      }
      this.dirty = true;
      await this.saveDraft({ force: true });
      if (!quiet) toast("已保存到草稿");
    }
    this.destroy();
  }
  destroy() {
    this.el.classList.remove("show");
    const el = this.el;
    setTimeout(() => el.remove(), 180);
    if (current === this) current = null;
  }
  async discard() {
    if (this.touched && !this.isEmpty() && !(await confirmDialog({ title: "舍弃这封邮件？", message: "草稿和已上传的附件都会被删除。", confirmLabel: "舍弃", danger: true }))) return;
    this.state.attachments.forEach((a) => a.abort?.());
    this.destroy();
    await api(`/drafts/${this.state.draftId}`, { method: "DELETE" }).catch(() => {});
    for (const a of this.state.attachments) if (a.uploadId) api(`/uploads/${a.uploadId}`, { method: "DELETE" }).catch(() => {});
    emit("drafts:changed");
    toast("已舍弃");
  }

  // ---- 发件地址输入框按内容自动变宽 ----
  sizeLocal() {
    const inp = this.el.querySelector(".from-local");
    inp.style.width = Math.min(24, Math.max(3, inp.value.length + 1)) + "ch";
  }

  // ---- 模板 ----
  async templatesMenu(anchor) {
    let list = [];
    try {
      list = await api("/templates");
    } catch (e) {
      return toastError(e);
    }
    menu(anchor, [
      { header: "插入模板" },
      ...(list.length ? list.map((t) => ({ label: t.name, icon: "template", onClick: () => this.applyTemplate(t) })) : [{ label: "还没有模板", disabled: true }]),
      "-",
      { label: "把当前内容存为模板…", icon: "plus", onClick: () => this.saveAsTemplate() },
      { label: "管理模板", icon: "settings", onClick: () => (location.hash = "#/settings/templates") },
    ], { align: "left" });
  }
  applyTemplate(t) {
    const area = this.editor.area;
    // 去掉开头的空段落，把模板插在签名/引用前面
    while (area.firstElementChild && !area.firstElementChild.matches(".signature, .cfm-quote") && !area.firstElementChild.textContent.trim() && !area.firstElementChild.querySelector("img")) {
      area.firstElementChild.remove();
    }
    const wrap = document.createElement("div");
    wrap.innerHTML = sanitizeHtml(t.html) + "<p><br></p>";
    area.prepend(...wrap.childNodes);
    const subj = this.el.querySelector(".subject");
    if (t.subject && !subj.value.trim()) {
      subj.value = t.subject;
      this.el.querySelector(".composer-title").textContent = t.subject;
    }
    this.editor.area.dispatchEvent(new Event("input"));
    toast(`已插入模板「${t.name}」`);
  }
  async saveAsTemplate() {
    const name = await promptDialog({ title: "存为模板", label: "模板名称", placeholder: "例如：报价回复" });
    if (!name?.trim()) return;
    const clone = this.editor.area.cloneNode(true);
    clone.querySelectorAll(".signature, .cfm-quote").forEach((n) => n.remove());
    try {
      await api(`/templates/${crypto.randomUUID()}`, { method: "PUT", body: { name: name.trim(), subject: this.el.querySelector(".subject").value, html: sanitizeHtml(clone.innerHTML) } });
      toast("模板已保存", { type: "success" });
    } catch (e) {
      toastError(e);
    }
  }

  // ---- AI 起草回复 ----
  async aiDraft() {
    const instruction = await promptDialog({ title: "AI 起草回复", label: "想表达什么？（可留空，让 AI 根据来信判断）", placeholder: "例如：同意报价，下周二前发合同" });
    if (instruction === null) return;
    const btn = this.el.querySelector('[data-act="ai"]');
    btn.disabled = true;
    btn.innerHTML = icon("loader", "spin");
    try {
      const { draft } = await api("/ai/reply", { body: { messageId: this.state.replyToId, instruction } });
      if (!draft) throw new Error("AI 没有返回内容，请重试");
      const area = this.editor.area;
      while (area.firstElementChild && !area.firstElementChild.matches(".signature, .cfm-quote") && !area.firstElementChild.textContent.trim()) area.firstElementChild.remove();
      const wrap = document.createElement("div");
      wrap.innerHTML = textToHtml(draft) + "<p><br></p>";
      area.prepend(...wrap.childNodes);
      area.dispatchEvent(new Event("input"));
      this.editor.focus(true);
    } catch (e) {
      toastError(e);
    } finally {
      btn.disabled = false;
      btn.innerHTML = icon("wand");
    }
  }

  // ---- 定时发送 ----
  scheduleMenu(anchor) {
    menu(anchor, [
      { header: "定时发送" },
      ...timePresets("send").map((p) => ({ label: `${p.label} · ${p.hint}`, icon: "calendarClock", onClick: () => this.send({ sendAt: p.ts }) })),
      "-",
      {
        label: "选择日期和时间…",
        icon: "clock",
        onClick: async () => {
          const ts = await pickDateTime({ title: "定时发送", confirmLabel: "安排发送" });
          if (ts) this.send({ sendAt: ts });
        },
      },
    ]);
  }

  // ---- 发送 ----
  async send({ sendAt } = {}) {
    const to = this.to.values();
    const cc = this.cc.values();
    const bcc = this.bcc.values();
    const invalid = [...this.to.invalid(), ...this.cc.invalid(), ...this.bcc.invalid()];
    if (invalid.length) return toast(`地址格式不正确：${invalid.join("、")}`, { type: "error" });
    if (!to.length && !cc.length && !bcc.length) {
      toast("请至少填写一个收件人", { type: "error" });
      this.to.input.focus();
      return;
    }
    const local = this.el.querySelector(".from-local").value.trim();
    if (!local || !isEmail(this.from)) return toast("发件地址不正确", { type: "error" });
    if (this.state.attachments.some((a) => a.status === "uploading")) return toast("附件还在上传，请稍候", { type: "error" });
    if (this.state.attachments.some((a) => a.status === "error")) return toast("有附件上传失败，请移除后重试", { type: "error" });
    if (this.totalSize() * 1.37 > this.limit()) return toast("附件超过当前发件服务的大小上限", { type: "error" });
    if (this.domainRow()?.send_provider === "none") return toast("这个域名还没有开通发件服务", { type: "error" });
    if (!this.el.querySelector(".subject").value.trim() && !(await confirmDialog({ title: "没有主题", message: "这封邮件没有主题，仍要发送吗？", confirmLabel: "仍然发送" }))) return;

    const payload = this.payload();
    // 先存一份草稿，撤销或失败时可以找回
    this.dirty = true;
    this.touched = true;
    await this.saveDraft({ force: true });
    const body = {
      ...payload,
      html: wrapHtml(payload.html),
      attachments: payload.attachments.map((a) => (a.uploadId ? { uploadId: a.uploadId } : { messageId: a.messageId, index: a.index })),
      draftId: this.state.draftId,
      ...(sendAt ? { sendAt } : {}),
    };
    const snapshot = { ...payload, draftId: this.state.draftId, updated_at: this.savedAt };
    this.destroy();
    prefs.set("lastFrom", payload.from);

    if (sendAt) {
      try {
        const r = await api("/send", { body });
        toast(`已安排在 ${fmtWhen(r.sendAt)} 发送`, {
          type: "success",
          action: {
            label: "撤销",
            onClick: async () => {
              const res = await api(`/scheduled/${r.scheduled}`, { method: "DELETE" }).catch(toastError);
              if (res?.payload) openComposer({ ...snapshot, ...res.payload, html: snapshot.html });
            },
          },
        });
        emit("drafts:changed");
        emit("scheduled:changed");
      } catch (e) {
        toast(`安排失败：${e.message}`, { type: "error", action: { label: "重新编辑", onClick: () => openComposer(snapshot) } });
      }
      return;
    }

    const delay = prefs.get("undoSeconds", 5);
    const job = { body, started: false, cancelled: false };
    pendingSends.add(job);
    const doSend = async () => {
      if (job.cancelled || job.started) return;
      job.started = true;
      const t = toast("正在发送…", { type: "loading", duration: 0 });
      try {
        const r = await api("/send", { body });
        t.close();
        toast(r.warning || "邮件已发送", {
          type: r.warning ? "info" : "success",
          action: r.threadId ? { label: "查看", onClick: () => navigate("sent", null, r.threadId) } : undefined,
        });
        // 主发件服务出问题、自动改用了备用服务
        if (r.via) toast(r.via, { type: "info", duration: 8000 });
        emit("mail:changed");
        emit("drafts:changed");
      } catch (e) {
        t.close();
        toast(`发送失败：${e.message}`, { type: "error", action: { label: "重新编辑", onClick: () => openComposer(snapshot) } });
      } finally {
        pendingSends.delete(job);
      }
    };
    if (delay > 0) {
      toast(`将在 ${delay} 秒后发送`, {
        type: "loading",
        duration: delay * 1000,
        action: {
          label: "撤销",
          onClick: () => {
            if (job.started) return toast("已经在发送了，无法撤销", { type: "error" });
            job.cancelled = true;
            pendingSends.delete(job);
            openComposer(snapshot);
          },
        },
        onTimeout: doSend,
        // 点 × 关闭提示 = 立即发送
        onDismiss: doSend,
      });
    } else {
      await doSend();
    }
  }
}

// 撤销倒计时中的发送：关闭/刷新页面时立即发出，而不是悄悄丢掉
const pendingSends = new Set();
window.addEventListener("pagehide", () => {
  for (const job of pendingSends) {
    if (job.started || job.cancelled) continue;
    job.started = true;
    fetch("/api/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(job.body), keepalive: true });
  }
});
export const hasPendingSends = () => [...pendingSends].some((j) => !j.started && !j.cancelled);

// 统一的邮件外观（收件方看到的样式）
function wrapHtml(html) {
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;font-size:14px;line-height:1.6;color:#1f2329">${html.replace(
    /<blockquote>/g,
    '<blockquote style="margin:0 0 0 .8ex;border-left:2px solid #d0d7e2;padding-left:1ex;color:#5b6474">',
  )}</div>`;
}

// ---------- 回复 / 转发 的预填 ----------
// 引用语言（"…写道："、转发信息）：可在设置里固定为中文或英文；默认跟随原邮件——
// 以汉字为主（且没有日文假名、韩文）时用中文，否则用英文
function quoteLang(m, html) {
  const pref = prefs.get("quoteLang", "auto");
  if (pref === "zh" || pref === "en") return pref;
  const body = m.text || (html ? html.replace(/<(style|script)[\s\S]*?<\/\1>|<[^>]+>|&[a-z#0-9]+;/gi, " ") : "") || m.snippet || "";
  const sample = `${m.subject || ""} ${body.slice(0, 4000)}`;
  if (/[\u3040-\u30ff\uac00-\ud7af]/.test(sample)) return "en";
  const han = (sample.match(/[\u4e00-\u9fff]/g) || []).length;
  const words = (sample.match(/[A-Za-z]{2,}/g) || []).length;
  return han >= 4 && han >= words * 0.5 ? "zh" : "en";
}

function quoteDate(ts, lang) {
  const d = new Date(ts * 1000);
  if (lang === "zh") return d.toLocaleString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  // 与 Gmail 一致：Thu, Oct 22, 2026 at 9:30 AM
  return `${d.toLocaleDateString("en-US", { weekday: "short", year: "numeric", month: "short", day: "numeric" })} at ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

export async function replyPrefill(m, mode) {
  const sent = m.folder === "sent";
  const me = m.mailbox;
  const subj = m.subject || "";
  // 会话详情里不再带 HTML 正文（减少流量），引用原文时再单独取
  let html = m.html ?? null;
  if (html === null && m.hasHtml) html = (await api(`/messages/${m.id}/body`).catch(() => ({ html: null }))).html;
  const quoteBody = html ? sanitizeHtml(html.length > 300000 ? textToHtml(m.text) : html) : textToHtml(m.text);
  const who = `${m.from_name ? esc(m.from_name) + " " : ""}&lt;${esc(m.from_addr)}&gt;`;
  const ql = quoteLang(m, html);
  const when = esc(quoteDate(m.created_at, ql));
  if (mode === "forward") {
    const fmt = (list) => parseList(list).map((a) => esc(a.name ? `${a.name} <${a.address}>` : a.address)).join(", ");
    const to = fmt(m.to_addrs);
    const cc = fmt(m.cc_addrs);
    const L = ql === "zh"
      ? { title: "---------- 转发的邮件 ----------", from: "发件人：", date: "日期：", subject: "主题：", to: "收件人：", cc: "抄送：" }
      : { title: "---------- Forwarded message ---------", from: "From: ", date: "Date: ", subject: "Subject: ", to: "To: ", cc: "Cc: " };
    const head = `${L.title}<br>${L.from}${who}<br>${L.date}${when}<br>${L.subject}${esc(subj)}<br>${L.to}${to}${cc ? `<br>${L.cc}${cc}` : ""}`;
    return {
      from: me,
      subject: /^(fwd?|转发)\s*[:：]/i.test(subj) ? subj : "Fwd: " + subj,
      quoteHtml: `<div class="cfm-quote"><p><br></p><div class="cfm-quote-head">${head}</div><br>${quoteBody}</div>`,
      attachments: (m.attachments || []).filter((a) => !a.inline).map((a) => ({ messageId: m.id, index: a.index, filename: a.filename, size: a.size, type: a.mimeType })),
      focus: "to",
      threadId: m.thread_id,
    };
  }
  const original = parseList(m.to_addrs).map((a) => a.address);
  const to = sent ? original : [m.reply_to || m.from_addr];
  let cc = [];
  if (mode === "replyAll") {
    const others = [...original, ...parseList(m.cc_addrs).map((a) => a.address)];
    cc = [...new Set(others)].filter((a) => a && a.toLowerCase() !== me && !to.includes(a));
  }
  return {
    from: me,
    to,
    cc,
    subject: /^(re|回复|答复)\s*[:：]/i.test(subj) ? subj : "Re: " + subj,
    quoteHtml: `<div class="cfm-quote"><p><br></p><div class="cfm-quote-head">${ql === "zh" ? `在 ${when}，${who} 写道：` : `On ${when}, ${who} wrote:`}</div><blockquote>${quoteBody}</blockquote></div>`,
    replyToId: m.id,
    threadId: m.thread_id,
  };
}
