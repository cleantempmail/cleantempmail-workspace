// 页面：登录、首次配置、域名管理（含健康检查）、地址管理
import { api, authApi } from "./api.js";
import { icon } from "./icons.js";
import { loginWithPasskey, passkeySupported } from "./passkey.js";
import { releaseResend } from "./resend.js";
import { emit, isAdmin, store } from "./store.js";
import { confirmDialog, menu, modal, toast, toastError } from "./ui.js";
import { $, avatarColor, esc, fmtRelative, h, lang } from "./util.js";

export const REPO_URL = "https://github.com/cleantempmail/cleantempmail-workspace";

const BRAND = `<span class="brand"><img src="/brand/logo.svg?v=3" alt="" class="brand-logo" /><span class="brand-text"><b>CleanTempMail</b><span class="brand-ws">Workspace</span></span></span>`;
export { BRAND };

// ---------- 登录 ----------
// 登录页左侧的产品预览：用 HTML 画一个迷你收件箱（清晰、随界面语言切换），展示多域名、原地址回复和防追踪
function heroPreview() {
  const en = lang() === "en";
  const T = en
    ? {
        compose: "Compose", inbox: "Inbox", starred: "Starred", sent: "Sent", domains: "Domains",
        rows: [
          ["AC", "#2f7bff", "Alice Chen", "09:41", "Partnership proposal", "We reviewed the proposal and can sign next week…", "sales@acme.com", "#f59e0b", true],
          ["GH", "#57606a", "GitHub", "09:12", "[studio] New pull request #128", "feat: add dark mode to the dashboard", "dev@studio.dev", "#ec4899", true],
          ["S", "#635bff", "Stripe", "Yesterday", "Your payout is on the way", "$2,480.00 will arrive in your bank account…", "billing@acme.com", "#f59e0b", false],
          ["MW", "#e5484d", "Ming Wang", "Yesterday", "Interview schedule", "Thursday 3 PM works for me, see you then", "hr@acme.com", "#f59e0b", false],
          ["CF", "#f38020", "Cloudflare", "Mon", "Your October invoice is ready", "$5.00 will be charged to your payment method", "billing@acme.com", "#f59e0b", false],
          ["AL", "#12a150", "Alex Li", "Mon", "Design review, round two", "Updated the home and pricing pages, take a look", "design@studio.dev", "#ec4899", false],
        ],
        to: "To sales@acme.com", subject: "Partnership proposal", blocked: "2 trackers blocked", reply: "Reply", from: "Sends from sales@acme.com",
        ai: "AI summary", aiText: "They've approved the proposal and want to sign next week. A draft contract is needed.",
        me: "Me", earlier: "Attached is proposal v2 for your review", earlierTime: "Yesterday",
      }
    : {
        compose: "写邮件", inbox: "收件箱", starred: "星标邮件", sent: "已发送", domains: "域名与地址",
        rows: [
          ["AC", "#2f7bff", "Alice Chen", "09:41", "合作方案确认", "我们看过方案了，下周可以签约…", "sales@acme.com", "#f59e0b", true],
          ["GH", "#57606a", "GitHub", "09:12", "[studio] 新的 Pull Request #128", "feat: 控制台支持深色模式", "dev@studio.dev", "#ec4899", true],
          ["S", "#635bff", "Stripe", "昨天", "你的付款已到账", "¥16,800.00 将在 1–2 个工作日内到账…", "billing@acme.com", "#f59e0b", false],
          ["王", "#e5484d", "王小明", "昨天", "面试时间安排", "周四下午三点可以，到时见", "hr@acme.com", "#f59e0b", false],
          ["CF", "#f38020", "Cloudflare", "周一", "你的 10 月账单已生成", "本月费用 $5.00，将从你的付款方式扣除", "billing@acme.com", "#f59e0b", false],
          ["李", "#12a150", "李安", "周一", "设计稿第二版", "首页和定价页都更新了，帮忙看看", "design@studio.dev", "#ec4899", false],
        ],
        to: "发给 sales@acme.com", subject: "合作方案确认", blocked: "已拦截 2 个追踪像素", reply: "回复", from: "将使用 sales@acme.com 发出",
        ai: "AI 摘要", aiText: "对方已确认合作方案，希望下周签约，需要准备合同初稿。",
        me: "我", earlier: "附件是合作方案第二版，请查收", earlierTime: "昨天",
      };
  const rows = T.rows
    .map(
      ([ini, c, name, time, subj, snip, box, dc, unread], i) => `<div class="pv-row ${unread ? "unread" : ""} ${i === 0 ? "on" : ""}">
        <span class="pv-av" style="--c:${c}">${ini}</span>
        <div class="pv-main"><div class="pv-top"><b>${name}</b><time>${time}</time></div><div class="pv-subj">${subj}</div>
          <div class="pv-bot"><span class="pv-snip">${snip}</span><span class="pv-chip"><i style="--c:${dc}"></i>${box}</span></div></div></div>`,
    )
    .join("");
  return `<div class="hero-preview" aria-hidden="true" data-no-i18n>
    <div class="pv-window">
      <div class="pv-bar"><i></i><i></i><i></i><span class="pv-url">mail.acme.com</span></div>
      <div class="pv-body">
        <aside class="pv-side">
          <div class="pv-compose">${T.compose}</div>
          <div class="pv-nav on"><span>${T.inbox}</span><b>2</b></div>
          <div class="pv-nav"><span>${T.starred}</span></div>
          <div class="pv-nav"><span>${T.sent}</span></div>
          <div class="pv-group">${T.domains}</div>
          <div class="pv-dom"><i style="--c:#f59e0b"></i>acme.com</div>
          <div class="pv-addr">sales@</div><div class="pv-addr">hr@</div><div class="pv-addr">billing@</div>
          <div class="pv-dom"><i style="--c:#ec4899"></i>studio.dev</div>
        </aside>
        <section class="pv-list">${rows}</section>
        <section class="pv-reader">
          <div class="pv-h">${T.subject}</div>
          <div class="pv-ai"><b>${icon("sparkles")}${T.ai}</b><span>${T.aiText}</span></div>
          <div class="pv-collapsed"><span class="pv-av" style="--c:#0a66d8">${T.me === "我" ? "我" : "Me"}</span><b>${T.me}</b><span>${T.earlier}</span><time>${T.earlierTime}</time></div>
          <div class="pv-card">
            <div class="pv-sender"><span class="pv-av" style="--c:#2f7bff">AC</span><div><b>Alice Chen</b><span>${T.to}</span></div></div>
            <div class="pv-shield">${icon("shieldCheck")}${T.blocked}</div>
            <i class="pv-line" style="width:92%"></i><i class="pv-line" style="width:84%"></i><i class="pv-line" style="width:88%"></i><i class="pv-line" style="width:52%"></i>
          </div>
          <div class="pv-replybar"><span class="pv-btn">${icon("reply")}${T.reply}</span><span class="pv-from">${T.from}</span></div>
        </section>
      </div>
    </div>
  </div>`;
}

export function renderLogin(root) {
  root.innerHTML = `
  <div class="auth">
    <div class="auth-hero">
      ${BRAND}
      <h1>你的所有域名，<br />一个收件箱。</h1>
      <ul class="auth-points">
        <li>${icon("zap")}<div><b>一键开通</b><span>选中域名，自动配置收发件</span></div></li>
        <li>${icon("at")}<div><b>任意地址都能收</b><span>默认 Catch-all，无需提前建邮箱</span></div></li>
        <li>${icon("reply")}<div><b>用原地址回复</b><span>收到哪个地址，就用哪个地址回复</span></div></li>
        <li>${icon("shield")}<div><b>数据在你自己的账户</b><span>邮件存在你自己的 D1 与 R2</span></div></li>
      </ul>
      ${heroPreview()}
    </div>
    <div class="auth-panel">
      <div class="auth-card">
        <h2>登录 Workspace</h2>
        <p class="muted">管理员登录</p>
        ${
          store.me.passwordLogin
            ? `<form class="admin-login" novalidate>
          <input class="input" type="password" name="password" placeholder="管理员密码" autocomplete="current-password" aria-label="管理员密码" />
          <button class="btn primary lg block" type="submit">${icon("logIn")}登录</button>
        </form>`
            : ""
        }
        ${store.me.passwordLogin ? `<p class="small center-text forgot"><button class="link-btn" data-forgot>忘记密码？</button></p>` : ""}
        ${store.me.passkeyLogin && passkeySupported() ? `<button class="btn lg block" data-passkey>${icon("key")}使用通行密钥登录</button>` : ""}
        ${
          store.me.oauthConfigured || store.me.devLogin
            ? `<a class="btn ${store.me.passwordLogin ? "" : "primary"} lg block" href="/auth/login">${icon("cloud")}使用 Cloudflare 登录</a>`
            : ""
        }
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
  const admin = root.querySelector(".admin-login");
  if (admin) {
    admin.password.focus();
    admin.onsubmit = async (e) => {
      e.preventDefault();
      const btn = admin.querySelector("button");
      btn.disabled = true;
      try {
        await authApi("/password", { password: admin.password.value });
        location.reload();
      } catch (err) {
        btn.disabled = false;
        admin.password.select();
        toast(err.message, { type: "error" });
      }
    };
  }
  root.querySelector("[data-forgot]")?.addEventListener("click", () => resetPasswordModal());
  root.querySelector("[data-passkey]")?.addEventListener("click", async (e) => {
    e.currentTarget.disabled = true;
    try {
      await loginWithPasskey();
      location.reload();
    } catch (err) {
      e.currentTarget.disabled = false;
      toast(err.message, { type: "error" });
    }
  });
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

// 忘记密码：粘贴同一个 Cloudflare 账户的 API 令牌，重新设置密码
function resetPasswordModal() {
  const body = h(`<form class="form reset-form" novalidate>
    <p class="dialog-text">能为部署本应用的 Cloudflare 账户创建 API 令牌，就能证明你是管理员。创建一个令牌粘贴到下面，然后设置新密码。</p>
    <a class="btn sm" href="${tokenTemplateUrl()}" target="_blank" rel="noopener">${icon("external")}在 Cloudflare 创建令牌</a>
    <label class="field-label">API 令牌</label><input class="input" name="token" type="password" autocomplete="off" spellcheck="false" />
    <label class="field-label">新密码（至少 10 位）</label><input class="input" name="password" type="password" autocomplete="new-password" />
    <label class="field-label">再输入一次</label><input class="input" name="password2" type="password" autocomplete="new-password" />
  </form>`);
  const f = body;
  modal({
    title: "重设管理员密码",
    body,
    actions: [
      { label: "取消" },
      {
        label: "重设并登录",
        kind: "primary",
        onClick: async () => {
          if (f.password.value !== f.password2.value) {
            toast("两次输入的密码不一致", { type: "error" });
            return false;
          }
          const r = await authApi("/reset", { token: f.token.value, password: f.password.value });
          for (const w of r.warnings || []) toast(w, { type: "info", duration: 8000 });
          setTimeout(() => location.reload(), 300);
        },
      },
    ],
  });
}

// ---------- 首次设置 ----------
// 令牌需要的权限（与 OAuth 的权限对应）。键名用于 Cloudflare 的「预填权限」链接
const TOKEN_PERMS = [
  ["user_details", "read", "User Details · Read"],
  ["account_settings", "read", "Account Settings · Read"],
  ["workers_scripts", "read", "Workers Scripts · Read"],
  ["zone", "read", "Zone · Read"],
  ["zone_settings", "edit", "Zone Settings · Edit"],
  ["dns", "edit", "DNS · Edit"],
  ["email_routing_rules", "edit", "Email Routing Rules · Edit"],
  ["email_sending", "edit", "Email Sending · Edit"],
  ["analytics", "read", "Analytics · Read (optional)"],
];
export const tokenTemplateUrl = () =>
  `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${encodeURIComponent(JSON.stringify(TOKEN_PERMS.map(([key, type]) => ({ key, type }))))}&accountId=*&zoneId=all&name=${encodeURIComponent("CleanTempMail Workspace")}`;
export const tokenPermsHtml = () => `<div class="scope-list">${TOKEN_PERMS.map(([, , label]) => `<code>${esc(label)}</code>`).join("")}</div>`;

export function renderSetup(root) {
  const code = (s) => `<div class="code"><code>${esc(s)}</code><button class="icon-btn xs" data-copy="${esc(s)}" title="复制" aria-label="复制">${icon("check", "copied")}<span class="copy-ic">${icon("draft")}</span></button></div>`;
  root.innerHTML = `
  <div class="setup-page">
    <div class="setup-card">
      ${BRAND}
      <h1>欢迎！三步完成设置</h1>
      <p class="muted">为了自动配置域名和收发件，Workspace 需要一个能访问你 Cloudflare 账户的 API 令牌。令牌加密后只保存在你自己的数据库里。</p>
      <form class="setup-form" novalidate>
        <ol class="setup-steps">
          <li><b>创建 API 令牌</b>
            <span>点下面的按钮，需要的权限已经预先选好。在「账户资源」里选择部署了本应用的账户，然后点「继续以显示摘要」→「创建令牌」，复制生成的令牌。</span>
            <a class="btn primary sm" href="${tokenTemplateUrl()}" target="_blank" rel="noopener">${icon("external")}在 Cloudflare 创建令牌</a>
            <details class="perm-list"><summary>需要的权限（如果没有自动选上，手动添加这些）</summary>${tokenPermsHtml()}</details></li>
          <li><b>粘贴令牌</b>
            <input class="input" name="token" type="password" autocomplete="off" spellcheck="false" placeholder="粘贴刚才复制的令牌" aria-label="API 令牌" /></li>
          <li><b>设置管理员密码</b>
            <span>以后用这个密码登录，至少 10 位。登录后还可以在「设置 → 账户与安全」添加通行密钥（指纹 / 面容）。</span>
            <input class="input" name="password" type="password" autocomplete="new-password" placeholder="管理员密码" aria-label="管理员密码" />
            <input class="input" name="password2" type="password" autocomplete="new-password" placeholder="再输入一次" aria-label="再输入一次密码" /></li>
        </ol>
        <button class="btn primary lg" type="submit">${icon("check")}完成设置</button>
      </form>
      <details class="setup-advanced">
        <summary>高级：改用 Cloudflare OAuth 登录（可选）</summary>
        <p class="muted small">如果你更希望用 Cloudflare 账户直接登录，可以在同一个账户里创建一个<b>私有</b> OAuth 客户端（只有本账户成员能授权）。配置好以后，登录页会出现「使用 Cloudflare 登录」。</p>
        <ol class="setup-steps">
          <li><b>打开 OAuth 客户端页面</b><span>Cloudflare 控制台 → Manage Account → OAuth clients → Create client</span>
            <a class="btn sm" href="https://dash.cloudflare.com/?to=/:account/oauth-clients" target="_blank" rel="noopener">${icon("external")}打开控制台</a></li>
          <li><b>基本设置</b><span>Response Type 选 <code>Code</code>；Grant Type 选 <code>Authorization Code</code> 和 <code>Refresh Token</code>；Token Authentication Method 选 <code>Client Secret Basic</code></span></li>
          <li><b>Redirect URL</b>${code(store.me.redirectUri)}</li>
          <li><b>勾选权限</b><div class="scope-list">${store.me.scopes.map((s) => `<code>${esc(s)}</code>`).join("")}</div>
            <span>可选：再勾选 ${store.me.optionalScopes.map((s) => `<code>${esc(s)}</code>`).join(" ")}，用于显示外发邮件的投递状态（已送达 / 退信）。</span></li>
          <li><b>保存 Client ID 与 Secret</b><span>Workers → 本 Worker → Settings → Runtime variables and secrets，添加两个 <b>Secret</b> 类型变量：</span>${code("CF_OAUTH_CLIENT_ID")}${code("CF_OAUTH_CLIENT_SECRET")}</li>
        </ol>
        ${store.me.oauthConfigured ? `<a class="btn" href="/auth/login">${icon("cloud")}使用 Cloudflare 登录</a>` : ""}
      </details>
    </div>
  </div>`;
  const form = root.querySelector(".setup-form");
  form.onsubmit = async (e) => {
    e.preventDefault();
    const token = form.token.value.trim();
    if (!token) return toast("请粘贴 API 令牌", { type: "error" });
    if (form.password.value.length < 10) return toast("密码至少 10 位", { type: "error" });
    if (form.password.value !== form.password2.value) return toast("两次输入的密码不一致", { type: "error" });
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    const t = toast("正在检查令牌…", { type: "loading", duration: 0 });
    try {
      const r = await authApi("/setup", { token, password: form.password.value });
      t.close();
      for (const w of r.warnings || []) toast(w, { type: "info", duration: 8000 });
      setTimeout(() => location.reload(), (r.warnings || []).length ? 2500 : 300);
    } catch (err) {
      t.close();
      btn.disabled = false;
      toast(err.message, { type: "error", duration: 8000 });
    }
  };
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
