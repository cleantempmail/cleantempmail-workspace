// 通用 UI：提示条、对话框、下拉菜单
import { icon } from "./icons.js";
import { esc, h } from "./util.js";

// ---------- Toast ----------
let toastRoot;
export function toast(message, { type = "info", action, duration, onTimeout, onDismiss } = {}) {
  toastRoot ??= document.body.appendChild(h(`<div class="toasts" role="status" aria-live="polite"></div>`));
  const el = h(`<div class="toast ${type}">
    ${type === "error" ? icon("alert") : type === "success" ? icon("check") : type === "loading" ? icon("loader", "spin") : ""}
    <span class="toast-msg">${esc(message)}</span>
    ${action ? `<button class="toast-action">${esc(action.label)}</button>` : ""}
    <button class="toast-close" aria-label="关闭窗口">${icon("x")}</button>
  </div>`);
  toastRoot.appendChild(el);
  // 最多同时显示 3 条，挤掉最旧的（正在倒计时发送的不挤）
  const live = [...toastRoot.children].filter((t) => !t.classList.contains("loading"));
  live.slice(0, Math.max(0, live.length - 3)).forEach((t) => t.remove());
  requestAnimationFrame(() => el.classList.add("show"));
  let timer;
  const close = () => {
    clearTimeout(timer);
    el.classList.remove("show");
    // 淡出期间禁止再点按钮（例如"撤销"时邮件其实已经在发送了）
    el.querySelectorAll("button").forEach((b) => (b.disabled = true));
    setTimeout(() => el.remove(), 200);
  };
  const ms = duration ?? (type === "error" ? 7000 : action ? 6000 : 3000);
  if (ms > 0)
    timer = setTimeout(() => {
      onTimeout?.();
      close();
    }, ms);
  el.querySelector(".toast-close").onclick = () => {
    onDismiss?.();
    close();
  };
  if (action)
    el.querySelector(".toast-action").onclick = () => {
      clearTimeout(timer);
      action.onClick();
      close();
    };
  return {
    close,
    update(msg, t) {
      el.querySelector(".toast-msg").textContent = msg;
      if (t) el.className = `toast show ${t}`;
    },
  };
}
export const toastError = (e) => toast(e?.message || String(e), { type: "error" });

// ---------- Modal ----------
export function modal({ title, body, actions = [], wide = false, onClose, className = "" }) {
  const el = h(`<div class="modal-backdrop">
    <div class="modal ${wide ? "wide" : ""} ${className}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" data-close aria-label="关闭窗口">${icon("x")}</button></div>
      <div class="modal-body"></div>
      ${actions.length ? `<div class="modal-foot"></div>` : ""}
    </div></div>`);
  const bodyEl = el.querySelector(".modal-body");
  if (typeof body === "string") bodyEl.innerHTML = body;
  else if (body) bodyEl.appendChild(body);
  const foot = el.querySelector(".modal-foot");
  const close = (result) => {
    el.classList.remove("show");
    document.removeEventListener("keydown", onKey, true);
    setTimeout(() => el.remove(), 150);
    onClose?.(result);
  };
  for (const a of actions) {
    const b = h(`<button class="btn ${a.kind ?? ""}">${a.icon ? icon(a.icon) : ""}${esc(a.label)}</button>`);
    b.onclick = async () => {
      if (a.onClick) {
        b.disabled = true;
        try {
          const keep = await a.onClick(b);
          if (keep !== false) close(a.value);
        } catch (e) {
          toastError(e);
        } finally {
          b.disabled = false;
        }
      } else close(a.value);
    };
    foot.appendChild(b);
  }
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener("keydown", onKey, true);
  el.querySelector("[data-close]").onclick = () => close();
  el.addEventListener("mousedown", (e) => e.target === el && close());
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => (el.querySelector("[autofocus]") ?? foot?.querySelector(".primary"))?.focus(), 50);
  return { el, close, body: bodyEl };
}

// checkbox: { label, checked }，关闭时把勾选结果写回 checkbox.checked
export function confirmDialog({ title, message, confirmLabel = "确定", danger = false, checkbox = null }) {
  return new Promise((resolve) => {
    const m = modal({
      title,
      body: `<p class="dialog-text">${message}</p>${
        checkbox ? `<label class="dialog-check"><input type="checkbox" ${checkbox.checked ? "checked" : ""} /><span>${esc(checkbox.label)}</span></label>` : ""
      }`,
      actions: [
        { label: "取消", value: false },
        { label: confirmLabel, kind: danger ? "danger-solid" : "primary", value: true },
      ],
      onClose: (v) => {
        if (checkbox) checkbox.checked = Boolean(m.body.querySelector(".dialog-check input")?.checked);
        resolve(Boolean(v));
      },
    });
  });
}

export function promptDialog({ title, label, value = "", placeholder = "", confirmLabel = "确定" }) {
  return new Promise((resolve) => {
    const m = modal({
      title,
      body: `<label class="field-label">${esc(label)}</label><input class="input" autofocus value="${esc(value)}" placeholder="${esc(placeholder)}" />`,
      actions: [
        { label: "取消", value: null },
        { label: confirmLabel, kind: "primary", onClick: () => (result = m.body.querySelector("input").value) },
      ],
      onClose: () => resolve(result),
    });
    let result = null;
    const input = m.body.querySelector("input");
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        result = input.value;
        m.close();
      }
    });
  });
}

// ---------- 下拉菜单 ----------
let openMenu = null;
export function menu(anchor, items, { align = "right" } = {}) {
  closeMenu();
  const el = h(`<div class="menu" role="menu"></div>`);
  for (const it of items) {
    if (it === "-") {
      el.appendChild(h(`<div class="menu-sep"></div>`));
      continue;
    }
    if (it.header) {
      el.appendChild(h(`<div class="menu-header">${esc(it.header)}</div>`));
      continue;
    }
    const b = h(`<button class="menu-item ${it.danger ? "danger" : ""} ${it.active ? "active" : ""}" role="menuitem" ${it.disabled ? "disabled" : ""}>
      ${it.icon ? icon(it.icon) : `<span class="i"></span>`}<span>${esc(it.label)}</span>${it.hint ? `<kbd>${esc(it.hint)}</kbd>` : ""}${it.active ? icon("check", "menu-check") : ""}
    </button>`);
    b.onclick = (e) => {
      e.stopPropagation();
      closeMenu();
      it.onClick?.();
    };
    el.appendChild(b);
  }
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  const mw = el.offsetWidth;
  const mh = el.offsetHeight;
  let left = align === "right" ? r.right - mw : r.left;
  left = Math.max(8, Math.min(left, innerWidth - mw - 8));
  let top = r.bottom + 4;
  if (top + mh > innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  el.style.left = left + "px";
  el.style.top = top + "px";
  openMenu = el;
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => document.addEventListener("mousedown", outside, true), 0);
  return el;
}
function outside(e) {
  if (openMenu && !openMenu.contains(e.target)) closeMenu();
}
export function closeMenu() {
  if (!openMenu) return;
  openMenu.remove();
  openMenu = null;
  document.removeEventListener("mousedown", outside, true);
}
document.addEventListener("keydown", (e) => e.key === "Escape" && closeMenu());
window.addEventListener("resize", closeMenu);

// ---------- 日期时间选择 ----------
export function pickDateTime({ title = "选择时间", confirmLabel = "确定", min = Date.now() + 5 * 60000 } = {}) {
  return new Promise((resolve) => {
    const d = new Date(Math.max(min, Date.now() + 3600000));
    d.setMinutes(0, 0, 0);
    const pad = (n) => String(n).padStart(2, "0");
    const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    let result = null;
    const m = modal({
      title,
      body: `<label class="field-label">日期与时间</label><input class="input" type="datetime-local" value="${local}" autofocus />`,
      actions: [
        { label: "取消" },
        {
          label: confirmLabel,
          kind: "primary",
          onClick: () => {
            const v = m.body.querySelector("input").value;
            const t = new Date(v).getTime();
            if (!v || Number.isNaN(t) || t < Date.now() + 60000) throw new Error("请选择一个将来的时间");
            result = Math.floor(t / 1000);
          },
        },
      ],
      onClose: () => resolve(result),
    });
  });
}

// ---------- 多选标签 ----------
export function labelMenu(anchor, labels, selected, onToggle, onCreate) {
  closeMenu();
  const el = h(`<div class="menu label-menu" role="menu">
    <div class="menu-header">标签</div>
    <div class="label-items">${
      labels.length
        ? labels.map((l) => `<label class="menu-item check-item"><input type="checkbox" value="${esc(l.id)}" ${selected.includes(l.id) ? "checked" : ""}/><span class="label-dot" style="--lc:${esc(l.color)}"></span><span>${esc(l.name)}</span></label>`).join("")
        : `<div class="menu-empty">还没有标签</div>`
    }</div>
    <div class="menu-sep"></div>
    <button class="menu-item" data-new>${icon("plus")}<span>新建标签…</span></button>
  </div>`);
  el.querySelectorAll("input").forEach((i) => (i.onchange = () => onToggle(i.value, i.checked)));
  el.querySelector("[data-new]").onclick = () => {
    closeMenu();
    onCreate?.();
  };
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  el.style.left = Math.max(8, Math.min(r.right - el.offsetWidth, innerWidth - el.offsetWidth - 8)) + "px";
  el.style.top = (r.bottom + 4 + el.offsetHeight > innerHeight ? Math.max(8, r.top - el.offsetHeight - 4) : r.bottom + 4) + "px";
  openMenu = el;
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => document.addEventListener("mousedown", outside, true), 0);
}
