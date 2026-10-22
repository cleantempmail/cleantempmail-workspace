// 页面：登录、首次配置、域名管理（含健康检查）、地址管理
import { api } from "./api.js";
import { icon } from "./icons.js";
import { releaseResend } from "./resend.js";
import { emit, isAdmin, store } from "./store.js";
import { confirmDialog, menu, modal, toast, toastError } from "./ui.js";
import { $, avatarColor, esc, fmtRelative, h } from "./util.js";

export const REPO_URL = "https://github.com/cleantempmail/cleantempmail-workspace";

const BRAND = `<span class="brand"><img src="/brand/logo.svg?v=3" alt="" class="brand-logo" /><span class="brand-text"><b>CleanTempMail</b><span class="brand-ws">Workspace</span></span></span>`;
export { BRAND };

// ---------- 登录 ----------
export function renderLogin(root) {
  root.innerHTML = `
  <div class="auth">
    <div class="auth-hero">
      ${BRAND}
      <h1>你的所有域名，<br />一个收件箱。</h1>
      <ul class="auth-points">
        <li>${icon("zap")}<div><b>一键开通</b><span>选中 Cloudflare 里的域名，自动配置收件与发件</span></div></li>
        <li>${icon("at")}<div><b>任意地址都能收</b><span>默认 Catch-all，不用提前创建邮箱</span></div></li>
        <li>${icon("reply")}<div><b>用原地址回复</b><span>发到 sales@ 的邮件，回复时自动用 sales@ 发出</span></div></li>
        <li>${icon("shield")}<div><b>数据在你自己的账户</b><span>部署在你的 Cloudflare，邮件存在你的 D1 与 R2</span></div></li>
      </ul>
    </div>
    <div class="auth-panel">
      <div class="auth-card">
        <img src="/brand/logo.svg?v=3" alt="" class="auth-logo" />
        <h2>登录 Workspace</h2>
        <p class="muted">管理员使用部署本应用的 Cloudflare 账户登录</p>
        <a class="btn primary lg block" href="/auth/login">${icon("cloud")}使用 Cloudflare 登录</a>
        ${store.me.devLogin ? `<p class="small muted center-text">本地开发模式：将跳过 OAuth</p>` : ""}
        ${
          store.me.memberLogin
            ? `<div class="auth-divider"><span>团队成员</span></div>
        <form class="member-login" novalidate>
          <input class="input" type="email" name="email" placeholder="输入你的邮箱，获取登录链接" autocomplete="email" aria-label="成员邮箱" />
          <button class="btn block" type="submit">${icon("mail")}发送登录链接</button>
        </form>`
            : ""
        }
        ${store.me.unclaimed ? `<p class="small muted center-text auth-foot">第一个用 Cloudflare 登录的用户将成为管理员</p>` : ""}
        <p class="small center-text lang-switch" data-no-i18n><button class="link-btn" data-lang="zh">中文</button> · <button class="link-btn" data-lang="en">English</button> ·
          <a class="link-btn gh-link" href="${REPO_URL}" target="_blank" rel="noopener" aria-label="GitHub">${icon("github")}GitHub</a></p>
      </div>
    </div>
  </div>`;
  root.querySelectorAll("[data-lang]").forEach(
    (b) =>
      (b.onclick = () => {
        localStorage.setItem("cfm:lang", JSON.stringify(b.dataset.lang));
        location.reload();
      }),
  );
  const form = root.querySelector(".member-login");
  if (!form) return;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const email = form.email.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return toast("请输入有效的邮箱地址", { type: "error" });
    const btn = form.querySelector("button");
    btn.disabled = true;
    await fetch("/auth/magic", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) }).catch(() => {});
    form.innerHTML = `<div class="notice info">${icon("mail")}<span>如果 <b>${esc(email)}</b> 是团队成员，登录链接已发到这个邮箱（15 分钟内有效）。</span></div>`;
  };
}

// ---------- 首次配置 ----------
export function renderSetup(root) {
  const code = (s) => `<div class="code"><code>${esc(s)}</code><button class="icon-btn xs" data-copy="${esc(s)}" title="复制" aria-label="复制">${icon("check", "copied")}<span class="copy-ic">${icon("draft")}</span></button></div>`;
  root.innerHTML = `
  <div class="setup-page">
    <div class="setup-card">
      ${BRAND}
      <h1>还差一步：创建 OAuth 客户端</h1>
      <p class="muted">Workspace 部署在你自己的 Cloudflare 账户里。为了用 Cloudflare 账户登录并自动配置域名，需要在同一个账户里创建一个<b>私有</b> OAuth 客户端（只有本账户成员能授权，无需域名验证）。只需做一次。</p>
      <ol class="setup-steps">
        <li><b>打开 OAuth 客户端页面</b><span>Cloudflare 控制台 → Manage Account → OAuth clients → Create client</span>
          <a class="btn sm" href="https://dash.cloudflare.com/?to=/:account/oauth-clients" target="_blank" rel="noopener">${icon("external")}打开控制台</a></li>
        <li><b>基本设置</b><span>Response Type 选 <code>Code</code>；Grant Type 选 <code>Authorization Code</code> 和 <code>Refresh Token</code>；Token Authentication Method 选 <code>Client Secret Basic</code></span></li>
        <li><b>Redirect URL</b>${code(store.me.redirectUri)}</li>
        <li><b>勾选权限</b><div class="scope-list">${store.me.scopes.map((s) => `<code>${esc(s)}</code>`).join("")}</div>
          <span>可选：再勾选 ${store.me.optionalScopes.map((s) => `<code>${esc(s)}</code>`).join(" ")}，用于显示外发邮件的投递状态（已送达 / 退信）。</span></li>
        <li><b>保存 Client ID 与 Secret</b><span>Workers → 本 Worker → Settings → Runtime variables and secrets，添加两个 <b>Secret</b> 类型变量，然后部署：</span>${code("CF_OAUTH_CLIENT_ID")}${code("CF_OAUTH_CLIENT_SECRET")}</li>
      </ol>
      <button class="btn primary" data-reload>${icon("refresh")}我已设置完成，刷新</button>
    </div>
  </div>`;
  root.querySelector("[data-reload]").onclick = () => location.reload();
  bindCopy(root);
}

export function bindCopy(root) {
  root.querySelectorAll("[data-copy]").forEach(
    (b) =>
      (b.onclick = async () => {
        await navigator.clipboard.writeText(b.dataset.copy).catch(() => {});
        b.classList.add("done");
        setTimeout(() => b.classList.remove("done"), 1200);
      }),
  );
}

// ---------- 域名管理 ----------
const PROVIDER = { cloudflare: "Cloudflare Email Sending", resend: "Resend", none: "未开通" };
// 备用发件：主服务是 Cloudflare 时备用 Resend，反之亦然
function fallbackRow(d, admin, settings) {
  const other = d.send_provider === "cloudflare" ? "resend" : "cloudflare";
  const on = Boolean(d.fallback_provider);
  const needKey = !on && other === "resend" && !settings.resendConfigured;
  const sw = admin
    ? `<label class="switch dc-switch" title="主发件服务暂时无法发送（额度用完、未验证、服务异常）或邮件超过它的大小上限时，自动改用 ${PROVIDER[other]}">
        <input type="checkbox" data-fallback="${esc(d.name)}" aria-label="备用发件：${PROVIDER[other]}" ${on ? "checked" : ""} ${needKey || (!on && !store.me.canManage) ? "disabled" : ""} /><span></span></label>`
    : "";
  const info = on
    ? `${statusChip(d.fallback_status)}<span class="muted small">${PROVIDER[d.fallback_provider] ?? esc(d.fallback_provider)}</span>`
    : needKey && admin
      ? `<span class="muted small">先在 <a href="#/settings/sending">发件服务</a> 填写 Resend API Key</span>`
      : `<span class="muted small">未启用${admin ? ` · 出问题时自动改用 ${PROVIDER[other]}` : ""}</span>`;
  return `<div class="dc-row"><span class="dc-label">${icon("shield")}备用</span>${info}${sw}</div>`;
}

function statusChip(s, okText = "可用") {
  return (
    { active: `<span class="status ok">${okText}</span>`, pending: `<span class="status warn">验证中</span>`, error: `<span class="status err">失败</span>`, none: `<span class="status off">未开通</span>` }[s] ??
    `<span class="status off">${esc(s)}</span>`
  );
}

export async function renderDomainsPage(el) {
  const settings = store.settings ?? (store.settings = await api("/settings"));
  const domains = store.domains;
  const admin = isAdmin();
  el.innerHTML = `
  <div class="page">
    <div class="page-head">
      <div><h1>域名管理</h1><p class="muted">每个域名默认开启 Catch-all：发到任意地址的邮件都会进入收件箱。</p></div>
      ${admin ? `<button class="btn primary" data-add ${store.me.canManage ? "" : "disabled"}>${icon("plus")}添加域名</button>` : ""}
    </div>
    ${admin && !store.me.canManage ? `<div class="notice warn">${icon("alert")}<span>Cloudflare 授权已过期，管理域名需要 <a href="/auth/login">重新登录</a>。收发邮件不受影响。</span></div>` : ""}
    ${
      domains.length
        ? `<div class="domain-grid">${domains
            .map(
              (d) => `<div class="domain-card" data-domain="${esc(d.name)}">
            <div class="dc-head">
              <span class="dc-icon" style="--av:${avatarColor(d.name)}">${icon("globe")}</span>
              <div class="dc-title"><b>${esc(d.name)}</b><span class="muted small">${d.message_count ?? 0} 封邮件 · 添加于 ${fmtRelative(d.created_at)}</span></div>
              ${admin ? `<button class="icon-btn sm" data-domain-menu="${esc(d.name)}" aria-label="更多">${icon("more")}</button>` : ""}
            </div>
            <div class="dc-rows">
              <div class="dc-row"><span class="dc-label">${icon("inbox")}收件</span>${statusChip(d.receive_status, "已开启")}<span class="muted small">Catch-all · *@${esc(d.name)}</span></div>
              <div class="dc-row"><span class="dc-label">${icon("send")}发件</span>${statusChip(d.send_status)}${d.send_status === "none" ? "" : `<span class="muted small">${PROVIDER[d.send_provider] ?? esc(d.send_provider)}</span>`}</div>
              ${d.send_provider !== "none" && (admin || d.fallback_provider) ? fallbackRow(d, admin, settings) : ""}
            </div>
            ${d.send_detail && d.send_status !== "active" ? `<div class="dc-detail">${esc(d.send_detail)}</div>` : ""}
            ${d.fallback_provider && d.fallback_detail && d.fallback_status !== "active" ? `<div class="dc-detail"><b>备用：</b>${esc(d.fallback_detail)}</div>` : ""}
            <div class="dc-foot">
              <a class="btn sm ghost" href="#/domain/${encodeURIComponent(d.name)}">${icon("mail")}查看邮件</a>
              ${admin ? `<button class="btn sm ghost" data-health="${esc(d.name)}" ${store.me.canManage ? "" : "disabled"}>${icon("stethoscope")}健康检查</button>` : ""}
              ${admin && (d.send_status === "pending" || d.fallback_status === "pending") ? `<button class="btn sm ghost" data-refresh="${esc(d.name)}">${icon("refresh")}刷新状态</button>` : ""}
              ${admin && (d.send_provider === "none" || d.send_status === "error") ? `<button class="btn sm" data-fix="${esc(d.name)}">${icon("zap")}开通发件</button>` : ""}
            </div>
          </div>`,
            )
            .join("")}</div>`
        : `<div class="empty card-empty">${icon("globe", "empty-icon")}<h3>还没有域名</h3><p>${admin ? "点「添加域名」，从你的 Cloudflare 账户中选择一个域名。" : "管理员还没有为你分配域名。"}</p></div>`
    }
    ${
      admin && !settings.resendConfigured
        ? `<div class="notice info">${icon("info")}<span>Cloudflare 发件需要 Workers Paid（$5/月）。没有开通的话，可以先在 <a href="#/settings/sending">发件服务</a> 填写 Resend API Key，开通发件时会自动改用 Resend。</span></div>`
        : ""
    }
  </div>`;

  el.querySelector("[data-add]")?.addEventListener("click", () => addDomainModal());
  el.querySelectorAll("[data-domain-menu]").forEach((b) => (b.onclick = () => domainMenu(b, b.dataset.domainMenu)));
  el.querySelectorAll("[data-health]").forEach((b) => (b.onclick = () => healthModal(b.dataset.health)));
  el.querySelectorAll("[data-refresh]").forEach(
    (b) =>
      (b.onclick = async () => {
        b.disabled = true;
        await api(`/domains/${encodeURIComponent(b.dataset.refresh)}/refresh`, { body: {} }).catch(toastError);
        emit("domains:refresh");
      }),
  );
  el.querySelectorAll("[data-fix]").forEach((b) => (b.onclick = () => domainMenu(b, b.dataset.fix)));
  el.querySelectorAll("[data-fallback]").forEach(
    (inp) =>
      (inp.onchange = async () => {
        const name = inp.dataset.fallback;
        const enabled = inp.checked;
        inp.disabled = true;
        const t = enabled ? toast(`正在为 ${name} 配置备用发件…`, { type: "loading", duration: 0 }) : null;
        try {
          const r = await api(`/domains/${encodeURIComponent(name)}/fallback`, { body: { enabled } });
          t?.close();
          if (!r.ok) toast(r.detail, { type: "error" });
          else if (!enabled) toast("已关闭备用发件");
          else toast(r.status === "pending" ? `已启用备用发件（${PROVIDER[r.provider]}），DNS 验证中` : `已启用备用发件（${PROVIDER[r.provider]}）`, { type: "success" });
        } catch (e) {
          t?.close();
          toastError(e);
        }
        emit("domains:refresh");
      }),
  );
}

function domainMenu(anchor, name) {
  const d = store.domains.find((x) => x.name === name);
  const setSending = async (provider) => {
    const t = toast(`正在为 ${name} 开通 ${PROVIDER[provider]}…`, { type: "loading", duration: 0 });
    try {
      const r = await api(`/domains/${encodeURIComponent(name)}/sending`, { body: { provider } });
      t.close();
      const last = r.steps[r.steps.length - 1];
      toast(last ? `${last.step}：${last.ok ? "成功" : last.detail}` : "完成", { type: last?.ok ? "success" : "error" });
    } catch (e) {
      t.close();
      toastError(e);
    }
    emit("domains:refresh");
  };
  menu(anchor, [
    { header: "发件服务" },
    { label: "Cloudflare Email Sending", icon: "cloud", active: d.send_provider === "cloudflare", disabled: !store.me.canManage, onClick: () => setSending("cloudflare") },
    { label: "Resend", icon: "send", active: d.send_provider === "resend", disabled: !store.me.canManage, onClick: () => setSending("resend") },
    ...(d.send_provider === "resend" || d.fallback_provider === "resend" ? [{ label: "停用 Resend 发件（释放名额）", icon: "ban", onClick: () => releaseResend(name) }] : []),
    "-",
    { label: "健康检查", icon: "stethoscope", disabled: !store.me.canManage, onClick: () => healthModal(name) },
    { label: "查看这个域名的邮件", icon: "mail", onClick: () => (location.hash = `#/domain/${encodeURIComponent(name)}`) },
    {
      label: "移除域名",
      icon: "trash",
      danger: true,
      disabled: !store.me.canManage,
      onClick: async () => {
        // 用过 Resend 的域名默认一起从 Resend 删除，否则名额会一直被占着
        const checkbox = store.settings?.resendConfigured
          ? { label: "同时从 Resend 删除这个域名（释放名额）", checked: d.send_provider === "resend" || d.fallback_provider === "resend" }
          : null;
        if (!(await confirmDialog({ title: `移除 ${name}？`, message: "将恢复配置前的 Catch-all 规则（如果有），之后不再接收新邮件。已收到的邮件会保留。", confirmLabel: "移除", danger: true, checkbox }))) return;
        try {
          const r = await api(`/domains/${encodeURIComponent(name)}${checkbox?.checked ? "?resend=1" : ""}`, { method: "DELETE" });
          toast(r.restored ? `已移除 ${name}，并恢复了原来的 Catch-all 规则` : `已移除 ${name}`);
          if (r.resend) toast(r.resend, { type: "info", duration: 7000 });
          emit("domains:refresh");
        } catch (e) {
          toastError(e);
        }
      },
    },
  ]);
}

async function healthModal(name) {
  const m = modal({ title: `健康检查 · ${name}`, body: `<div class="zone-loading">${icon("loader", "spin")} 正在检查 DNS 与路由配置…</div>`, wide: true });
  const render = (items, fixed) => {
    const bad = items.filter((i) => !i.ok);
    const fixable = bad.filter((i) => i.fixable);
    m.body.innerHTML = `
      ${fixed ? `<div class="notice info">${icon("sparkles")}<span>已尝试自动修复。DNS 变更通常需要几分钟生效。</span></div>` : ""}
      <ul class="health-list">${items
        .map(
          (i) => `<li class="${i.ok ? "ok" : "bad"}"><span class="h-ic">${icon(i.ok ? "check" : "alert")}</span>
            <div><b>${esc(i.label)}</b><span>${esc(i.detail || "")}</span></div>${!i.ok && !i.fixable ? `<span class="status warn">需手动处理</span>` : ""}</li>`,
        )
        .join("")}</ul>
      <div class="modal-inline-actions">
        <span class="muted small">${bad.length ? `${bad.length} 项需要注意` : "一切正常"}</span>
        <button class="btn" data-recheck>${icon("refresh")}重新检查</button>
        ${fixable.length ? `<button class="btn primary" data-fixall>${icon("zap")}一键修复 ${fixable.length} 项</button>` : ""}
      </div>`;
    m.body.querySelector("[data-recheck]").onclick = () => run();
    m.body.querySelector("[data-fixall]")?.addEventListener("click", async (e) => {
      e.currentTarget.disabled = true;
      e.currentTarget.innerHTML = `${icon("loader", "spin")}修复中…`;
      try {
        render(await api(`/domains/${encodeURIComponent(name)}/fix`, { body: {} }), true);
      } catch (err) {
        toastError(err);
        run();
      }
    });
  };
  const run = async () => {
    m.body.innerHTML = `<div class="zone-loading">${icon("loader", "spin")} 正在检查 DNS 与路由配置…</div>`;
    try {
      render(await api(`/domains/${encodeURIComponent(name)}/health`));
    } catch (e) {
      m.body.innerHTML = `<div class="notice err">${icon("alert")}<span>${esc(e.message)}</span></div>`;
    }
  };
  run();
}

function addDomainModal() {
  const body = h(`<div class="add-domain">
    <div class="search-field">${icon("search")}<input class="input" placeholder="搜索域名…" autofocus aria-label="搜索域名" /></div>
    <div class="zone-list"><div class="zone-loading">${icon("loader", "spin")} 正在读取 Cloudflare 账户中的域名…</div></div>
  </div>`);
  const m = modal({ title: "添加域名", body, wide: true });
  const list = body.querySelector(".zone-list");
  const input = body.querySelector("input");
  let zones = [];
  const render = () => {
    const q = input.value.trim().toLowerCase();
    const shown = zones.filter((z) => z.name.includes(q));
    list.innerHTML = shown.length
      ? shown
          .map(
            (z) => `<div class="zone-row"><span class="zone-name">${icon("globe")}${esc(z.name)}</span>
            ${z.configured ? `<span class="status ok">已添加</span>` : `<button class="btn sm primary" data-zone="${esc(z.id)}" data-name="${esc(z.name)}">一键配置</button>`}</div>`,
          )
          .join("")
      : `<div class="zone-loading">${zones.length ? "没有匹配的域名" : "账户里没有可用的域名（需要先接入 Cloudflare DNS）"}</div>`;
    list.querySelectorAll("[data-zone]").forEach((b) => (b.onclick = () => provision(m, b.dataset.zone, b.dataset.name)));
  };
  input.addEventListener("input", render);
  api("/zones")
    .then((z) => {
      zones = z;
      render();
    })
    .catch((e) => {
      list.innerHTML = `<div class="notice err">${icon("alert")}<span>${esc(e.message)}</span></div>`;
    });
}

const STEP_NAMES = ["检查 MX 记录", "开启 Email Routing", "开启 Catch-all", "开通发件服务"];

async function provision(m, zoneId, name, replaceMx = false) {
  const steps = (cur) =>
    `<ul class="steps">${STEP_NAMES.map((s, i) => `<li class="${i < cur ? "done" : i === cur ? "doing" : ""}"><span class="step-ic">${i < cur ? icon("check") : i === cur ? icon("loader", "spin") : ""}</span>${s}</li>`).join("")}</ul>`;
  m.body.innerHTML = `<div class="prov"><h4>${icon("globe")}${esc(name)}</h4>${steps(0)}</div>`;
  let cur = 0;
  const tick = setInterval(() => {
    if (cur < STEP_NAMES.length - 1) m.body.querySelector(".prov").innerHTML = `<h4>${icon("globe")}${esc(name)}</h4>${steps(++cur)}`;
  }, 900);
  try {
    const r = await api("/domains", { body: { zoneId, replaceMx } });
    clearInterval(tick);
    if (r.conflict) {
      m.body.innerHTML = `<div class="prov">
        <div class="notice warn">${icon("alert")}<div><b>${esc(name)} 正在使用其他邮件服务</b><p>继续将删除下面这些 MX 记录（会先备份），原来的邮箱（如 Microsoft 365、Google Workspace）将收不到新邮件。</p>
        <ul class="mx-list">${r.conflict.mx.map((x) => `<li><code>${esc(x.content)}</code><span class="muted">优先级 ${x.priority ?? "-"}</span></li>`).join("")}</ul></div></div>
        <div class="modal-inline-actions"><button class="btn" data-cancel>取消</button><button class="btn danger-solid" data-go>删除这些记录并继续</button></div></div>`;
      m.body.querySelector("[data-cancel]").onclick = () => m.close();
      m.body.querySelector("[data-go]").onclick = () => provision(m, zoneId, name, true);
      return;
    }
    m.body.innerHTML = `<div class="prov">
      <h4>${r.ok ? icon("check", "ok-ic") : icon("alert", "err-ic")}${esc(name)} ${r.ok ? "已配置完成" : "配置未完成"}</h4>
      <ul class="steps result">${r.steps.map((s) => `<li class="${s.ok ? "done" : "fail"}"><span class="step-ic">${icon(s.ok ? "check" : "alert")}</span><div><b>${esc(s.step)}</b>${s.detail ? `<span>${esc(s.detail)}</span>` : ""}</div></li>`).join("")}</ul>
      ${r.ok ? `<div class="notice info">${icon("sparkles")}<span>现在发到 <b>任意地址@${esc(name)}</b> 的邮件都会进入收件箱，回复时会自动使用收件地址。</span></div>` : ""}
      <div class="modal-inline-actions"><button class="btn primary" data-done>完成</button></div></div>`;
    m.body.querySelector("[data-done]").onclick = () => m.close();
    emit("domains:refresh");
  } catch (e) {
    clearInterval(tick);
    m.body.innerHTML = `<div class="notice err">${icon("alert")}<span>${esc(e.message)}</span></div>`;
  }
}

// ---------- 地址管理 ----------
const COLORS = ["", "#2f7bff", "#7c5cff", "#e5484d", "#f5a623", "#12a150", "#0ea5b7", "#d6409f"];

export async function renderAddressesPage(el) {
  el.innerHTML = `<div class="page"><div class="zone-loading">${icon("loader", "spin")} 加载中…</div></div>`;
  let list = [];
  try {
    list = await api("/addresses");
  } catch (e) {
    el.innerHTML = `<div class="page"><div class="notice err">${icon("alert")}<span>${esc(e.message)}</span></div></div>`;
    return;
  }
  const admin = isAdmin();
  let q = "";
  const draw = () => {
    const shown = list.filter((a) => !q || a.address.includes(q) || (a.note || "").toLowerCase().includes(q));
    const byDomain = new Map();
    for (const a of shown) byDomain.set(a.domain, [...(byDomain.get(a.domain) ?? []), a]);
    el.querySelector(".addr-body").innerHTML = shown.length
      ? [...byDomain]
          .map(
            ([d, rows]) => `<section class="addr-group"><h3>${icon("globe")}${esc(d)}<span class="muted small">${rows.length} 个地址</span></h3>
            <div class="addr-table" role="table">${rows
              .map(
                (a) => `<div class="addr-row ${a.blocked ? "blocked" : ""}" role="row" data-addr="${esc(a.address)}">
                <span class="addr-color" style="--lc:${esc(a.color || "transparent")}"></span>
                <div class="addr-main"><b>${esc(a.address)}</b><span class="muted small">${a.note ? esc(a.note) + " · " : ""}${a.total} 封${a.unread ? ` · ${a.unread} 未读` : ""}${a.spam_count ? ` · ${a.spam_count} 垃圾` : ""} · 最近 ${fmtRelative(a.last_at)}</span></div>
                ${a.blocked ? `<span class="status err">已停用</span>` : a.muted ? `<span class="status off">${icon("bellOff")}静音</span>` : ""}
                <a class="btn sm ghost" href="#/box/${encodeURIComponent(a.address)}">查看</a>
                <button class="icon-btn sm" data-edit aria-label="编辑">${icon("more")}</button>
              </div>`,
              )
              .join("")}</div></section>`,
          )
          .join("")
      : `<div class="empty card-empty">${icon("at", "empty-icon")}<h3>${q ? "没有匹配的地址" : "还没有地址"}</h3><p>收到或发出邮件后，用过的地址会出现在这里。</p></div>`;
    el.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => addressMenu(b, list.find((a) => a.address === b.closest(".addr-row").dataset.addr), draw)));
  };
  el.innerHTML = `
    <div class="page">
      <div class="page-head"><div><h1>地址管理</h1><p class="muted">Catch-all 会收下任意地址的邮件。在这里给常用地址加备注和颜色、关闭通知，或者<b>停用</b>已经泄露、只收到垃圾邮件的地址。</p></div></div>
      <div class="search-field page-search">${icon("search")}<input class="input" placeholder="搜索地址或备注…" aria-label="搜索地址" /></div>
      <div class="addr-body"></div>
    </div>`;
  el.querySelector(".page-search input").addEventListener("input", (e) => {
    q = e.target.value.trim().toLowerCase();
    draw();
  });
  draw();

  async function addressMenu(anchor, a, redraw) {
    const patch = async (body, msg) => {
      try {
        await api(`/addresses/${encodeURIComponent(a.address)}`, { method: "PATCH", body });
        Object.assign(a, Object.fromEntries(Object.entries(body).map(([k, v]) => [k, typeof v === "boolean" ? Number(v) : v])));
        if (msg) toast(msg, { type: "success" });
        redraw();
        emit("addresses:changed");
      } catch (e) {
        toastError(e);
      }
    };
    menu(anchor, [
      { header: a.address },
      {
        label: "编辑备注…",
        icon: "pen",
        onClick: async () => {
          const { promptDialog } = await import("./ui.js");
          const v = await promptDialog({ title: "地址备注", label: "备注会显示在侧栏和地址列表里", value: a.note || "", placeholder: "例如：注册 GitHub 用、给客户的地址" });
          if (v !== null) patch({ note: v.trim() || null });
        },
      },
      { label: "颜色", icon: "tag", onClick: () => colorPicker(anchor, a.color, (c) => patch({ color: c || null })) },
      { label: a.muted ? "恢复新邮件通知" : "不再推送新邮件通知", icon: "bellOff", onClick: () => patch({ muted: !a.muted }, a.muted ? "已恢复通知" : "已静音") },
      admin ? "-" : null,
      admin
        ? a.blocked
          ? { label: "重新启用这个地址", icon: "check", onClick: () => patch({ blocked: false }, `${a.address} 已重新启用`) }
          : {
              label: "停用这个地址…",
              icon: "ban",
              danger: true,
              onClick: async () => {
                const ok = await confirmDialog({ title: `停用 ${a.address}？`, message: "之后发到这个地址的邮件会被直接拒收（发件方会收到退信）。已收到的邮件不受影响，可以随时重新启用。", confirmLabel: "停用", danger: true });
                if (ok) patch({ blocked: true }, `${a.address} 已停用`);
              },
            }
        : null,
    ].filter(Boolean));
  }
}

function colorPicker(anchor, current, onPick) {
  const el = h(`<div class="menu color-menu show" role="menu"><div class="menu-header">颜色</div><div class="color-row">${COLORS.map((c) => `<button class="color-dot ${c === (current || "") ? "on" : ""} ${c ? "" : "none"}" data-c="${c}" style="--lc:${c || "transparent"}" aria-label="${c || "无"}"></button>`).join("")}</div></div>`);
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  el.style.left = Math.max(8, r.right - el.offsetWidth) + "px";
  el.style.top = r.bottom + 4 + "px";
  const close = () => (el.remove(), document.removeEventListener("mousedown", out, true));
  const out = (e) => !el.contains(e.target) && close();
  setTimeout(() => document.addEventListener("mousedown", out, true), 0);
  el.querySelectorAll(".color-dot").forEach(
    (b) =>
      (b.onclick = () => {
        onPick(b.dataset.c);
        close();
      }),
  );
}

export { $ };
