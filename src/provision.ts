// 一键配置域名：开启 Email Routing → catch-all 投递到本 Worker → 开通发件
import { Cf } from "./cf";
import type { Env } from "./env";
import { resendApi, resendDomains, resendFindOrCreateDomain, resendKey, resendRecordFqdn, type Provider, type ResendDomain } from "./providers";
import { getSetting, now, setSetting, workerName } from "./util";

export interface Step {
  step: string;
  ok: boolean;
  detail?: string;
}

export interface ProvisionResult {
  ok: boolean;
  domain?: string;
  steps: Step[];
  // 域名已有第三方 MX（如 Google Workspace）时需要用户确认后才能继续
  conflict?: { mx: { name: string; content: string; priority?: number }[] };
}

const isCfRoutingMx = (content: string) => /(^|\.)mx\.cloudflare\.net\.?$/i.test(content);

export async function provisionDomain(
  env: Env,
  cf: Cf,
  accountId: string,
  zoneId: string,
  opts: { replaceMx?: boolean; preferProvider?: Provider } = {},
): Promise<ProvisionResult> {
  const steps: Step[] = [];
  const zone = await cf.zone(zoneId);
  const domain = zone.name;
  if (zone.account.id !== accountId) {
    return {
      ok: false,
      steps: [{ step: "检查域名", ok: false, detail: "该域名不在部署本应用的账户中，catch-all 无法投递到本 Worker" }],
    };
  }

  // 1. 检查现有 MX 记录（有第三方邮件服务时先征得同意）
  const mx = await cf.dnsRecords(zoneId, "MX", domain);
  const foreign = mx.filter((r) => !isCfRoutingMx(r.content));
  if (foreign.length && !opts.replaceMx) {
    return {
      ok: false,
      domain,
      steps: [{ step: "检查 MX 记录", ok: false, detail: "域名正在使用其他邮件服务" }],
      conflict: { mx: foreign.map((r) => ({ name: r.name, content: r.content, priority: r.priority })) },
    };
  }

  // 2. 先开启 Email Routing，成功后再删旧 MX：避免中途失败导致域名完全收不到信
  const routingOk = async () => (await cf.get<{ enabled: boolean }>(`/zones/${zoneId}/email/routing`).catch(() => null))?.enabled === true;
  try {
    await cf.post(`/zones/${zoneId}/email/routing/dns`, {});
  } catch (e: any) {
    if (!(await routingOk())) {
      steps.push({ step: "开启 Email Routing", ok: false, detail: `${e.message}（未改动任何 DNS 记录）` });
      return { ok: false, domain, steps };
    }
  }
  if (foreign.length) {
    // 备份旧 MX，移除域名时可以恢复
    await setSetting(env, `mx_backup:${zoneId}`, JSON.stringify(foreign.map((r) => ({ name: r.name, content: r.content, priority: r.priority }))));
    for (const r of foreign) await cf.del(`/zones/${zoneId}/dns_records/${r.id}`);
    // 删掉冲突记录后，让 Cloudflare 补齐被冲突挡住的 MX
    await cf.post(`/zones/${zoneId}/email/routing/dns`, {}).catch(() => {});
  }
  steps.push({ step: "检查 MX 记录", ok: true, detail: foreign.length ? `已删除 ${foreign.length} 条旧 MX 记录（已备份）` : "无冲突" });
  steps.push({ step: "开启 Email Routing", ok: true });

  // 3. Catch-all → 本 Worker（先备份原有规则）
  const worker = await workerName(env);
  try {
    const prev = await cf.get<{ actions: { type: string; value?: string[] }[]; matchers: unknown[]; enabled: boolean; name?: string }>(
      `/zones/${zoneId}/email/routing/rules/catch_all`,
    ).catch(() => null);
    const ours = prev?.actions?.some((a) => a.type === "worker" && a.value?.includes(worker));
    if (prev && !ours) await setSetting(env, `catchall_backup:${zoneId}`, JSON.stringify(prev));
    await cf.put(`/zones/${zoneId}/email/routing/rules/catch_all`, {
      name: "cf-mailbox catch-all",
      enabled: true,
      matchers: [{ type: "all" }],
      actions: [{ type: "worker", value: [worker] }],
    });
    steps.push({ step: "开启 Catch-all", ok: true, detail: `*@${domain} → ${worker}` });
  } catch (e: any) {
    steps.push({ step: "开启 Catch-all", ok: false, detail: e.message });
    return { ok: false, domain, steps };
  }

  const ts = now();
  await env.DB.prepare(
    `INSERT INTO domains (name, zone_id, account_id, receive_status, send_provider, send_status, created_at, updated_at)
     VALUES (?, ?, ?, 'active', 'none', 'none', ?, ?)
     ON CONFLICT(name) DO UPDATE SET zone_id = excluded.zone_id, account_id = excluded.account_id,
       receive_status = 'active', updated_at = excluded.updated_at`,
  ).bind(domain, zoneId, accountId, ts, ts).run();

  // 4. 发件：优先 Cloudflare，未开通 Workers Paid 时自动改用 Resend（如已配置 Key）
  const sendSteps = await setupSending(env, cf, domain, zoneId, opts.preferProvider);
  steps.push(...sendSteps);
  return { ok: true, domain, steps };
}

export async function setupSending(
  env: Env,
  cf: Cf | null,
  domain: string,
  zoneId: string,
  prefer?: Provider,
): Promise<Step[]> {
  const steps: Step[] = [];
  const [hasResend, prev] = await Promise.all([
    resendKey(env).then(Boolean),
    env.DB.prepare("SELECT send_provider, send_status, send_detail, send_meta, fallback_provider FROM domains WHERE name = ?").bind(domain).first<PrevSending>(),
  ]);
  // 显式切换失败时，不要把原来能用的发件服务覆盖成"未开通"
  const keepPrev = Boolean(prefer && prev && prev.send_provider !== "none" && prev.send_provider !== prefer && prev.send_status !== "error");
  const order: Provider[] =
    prefer === "resend" ? ["resend"] : prefer === "cloudflare" ? ["cloudflare"] : ["cloudflare", "resend"];
  let cfFailure: string | null = null;

  for (const p of order) {
    if (p === "cloudflare") {
      if (!cf) {
        steps.push({ step: "开通 Cloudflare 发件", ok: false, detail: "需要重新登录 Cloudflare" });
        continue;
      }
      const r = await setupCloudflareSending(cf, domain, zoneId);
      steps.push(r.step);
      if (r.status !== "error") {
        await saveSending(env, domain, "cloudflare", r.status, r.step.detail ?? null, null, prev);
        return steps;
      }
      cfFailure = r.step.detail ?? null;
      if (!keepPrev) await saveSending(env, domain, "none", "error", r.step.detail ?? null, null, prev);
    } else {
      if (!hasResend) {
        steps.push({
          step: "开通 Resend 发件",
          ok: false,
          detail: "未配置 Resend API Key。可在「设置」中填写后，点击域名旁的「改用 Resend」",
        });
        continue;
      }
      if (!cf) {
        steps.push({ step: "开通 Resend 发件", ok: false, detail: "需要重新登录 Cloudflare 以写入 DNS 记录" });
        continue;
      }
      try {
        const r = await setupResendSending(env, cf, domain, zoneId);
        steps.push({ step: "开通 Resend 发件", ok: true, detail: r.detail });
        await saveSending(env, domain, "resend", r.status, r.detail, JSON.stringify({ resendDomainId: r.id }), prev);
        return steps;
      } catch (e: any) {
        steps.push({ step: "开通 Resend 发件", ok: false, detail: e.message });
        const why = /^Resend/.test(e.message) ? e.message : `Resend：${e.message}`;
        if (!keepPrev) await saveSending(env, domain, "none", "error", cfFailure ? `Cloudflare：${cfFailure}；${why}` : why, null, prev);
      }
    }
  }
  return steps;
}

interface PrevSending {
  send_provider: Provider;
  send_status: string;
  send_detail: string | null;
  send_meta: string | null;
  fallback_provider: Provider | null;
}

async function saveSending(
  env: Env,
  domain: string,
  provider: Provider,
  status: string,
  detail: string | null,
  meta: string | null,
  prev?: PrevSending | null,
) {
  const stmts = [
    env.DB.prepare("UPDATE domains SET send_provider = ?, send_status = ?, send_detail = ?, send_meta = ?, updated_at = ? WHERE name = ?").bind(
      provider,
      status,
      detail,
      meta,
      now(),
      domain,
    ),
  ];
  // 主服务换成了原来的备用服务：原来的主服务（如果可用）改当备用，否则关闭备用
  if (prev?.fallback_provider && (prev.fallback_provider === provider || provider === "none")) {
    const swap = provider !== "none" && prev.send_provider !== "none" && prev.send_provider !== provider && prev.send_status !== "error";
    stmts.push(
      env.DB.prepare("UPDATE domains SET fallback_provider = ?, fallback_status = ?, fallback_detail = ?, fallback_meta = ? WHERE name = ?").bind(
        swap ? prev.send_provider : null,
        swap ? prev.send_status : null,
        swap ? prev.send_detail : null,
        swap ? prev.send_meta : null,
        domain,
      ),
    );
  }
  await env.DB.batch(stmts);
}

// ---------- 备用发件 ----------
// 主服务是 Cloudflare 时备用 Resend，反之亦然。两者的 DNS 记录互不冲突：
// Cloudflare 用 cf-bounce.<域名> 和自己的 DKIM 选择器，Resend 用 send.<域名> 和 resend._domainkey。
export async function setFallback(
  env: Env,
  cf: Cf | null,
  domain: string,
  enabled: boolean,
): Promise<{ ok: boolean; detail: string; provider?: Provider; status?: string }> {
  const row = await env.DB.prepare("SELECT zone_id, send_provider FROM domains WHERE name = ?").bind(domain).first<{ zone_id: string; send_provider: Provider }>();
  if (!row) return { ok: false, detail: "域名不存在" };
  if (!enabled) {
    await env.DB.prepare("UPDATE domains SET fallback_provider = NULL, fallback_status = NULL, fallback_detail = NULL, fallback_meta = NULL, updated_at = ? WHERE name = ?")
      .bind(now(), domain)
      .run();
    return { ok: true, detail: "已关闭备用发件" };
  }
  if (row.send_provider === "none") return { ok: false, detail: "请先开通主发件服务" };
  if (!cf) return { ok: false, detail: "需要重新登录 Cloudflare 以写入 DNS 记录" };
  const provider: Provider = row.send_provider === "cloudflare" ? "resend" : "cloudflare";
  let status: "active" | "pending" | "error";
  let detail: string;
  let meta: string | null = null;
  if (provider === "cloudflare") {
    const r = await setupCloudflareSending(cf, domain, row.zone_id);
    status = r.status;
    detail = r.step.detail ?? "";
  } else {
    if (!(await resendKey(env))) return { ok: false, detail: "还没有配置 Resend API Key，请先在「设置 → 发件服务」填写" };
    try {
      const r = await setupResendSending(env, cf, domain, row.zone_id);
      status = r.status as "active" | "pending";
      detail = r.detail;
      meta = JSON.stringify({ resendDomainId: r.id });
    } catch (e: any) {
      return { ok: false, detail: /^Resend/.test(e.message) ? e.message : `Resend：${e.message}` };
    }
  }
  if (status === "error") return { ok: false, detail };
  await env.DB.prepare("UPDATE domains SET fallback_provider = ?, fallback_status = ?, fallback_detail = ?, fallback_meta = ?, updated_at = ? WHERE name = ?")
    .bind(provider, status, detail, meta, now(), domain)
    .run();
  return { ok: true, detail, provider, status };
}

async function setupCloudflareSending(
  cf: Cf,
  domain: string,
  zoneId: string,
): Promise<{ status: "active" | "pending" | "error"; step: Step }> {
  const name = "开通 Cloudflare 发件";
  let sub: { tag: string; enabled: boolean };
  try {
    const existing = await cf.get<{ tag: string; name: string; enabled: boolean }[]>(`/zones/${zoneId}/email/sending/subdomains`);
    const found = existing.find((s) => s.name === domain);
    sub = found?.enabled ? found : await cf.post(`/zones/${zoneId}/email/sending/subdomains`, { name: domain });
  } catch (e: any) {
    return {
      status: "error",
      step: { step: name, ok: false, detail: `${e.message}（通常是账户未开通 Workers Paid）` },
    };
  }
  // 写入缺失的 SPF / DKIM / DMARC / cf-bounce 记录；存在冲突时 Cloudflare 返回 409
  try {
    await cf.post(`/zones/${zoneId}/email/sending/subdomains/${sub.tag}/dns`);
    return { status: "active", step: { step: name, ok: true, detail: "DNS 记录已就绪，DNS 生效通常需要 5–15 分钟" } };
  } catch (e: any) {
    return {
      status: "pending",
      step: {
        step: name,
        ok: false,
        detail: `已开通，但 DNS 记录有冲突（例如已有多条 SPF/DMARC），需要在 Cloudflare 控制台手动清理：${e.message}`,
      },
    };
  }
}

const RESEND_COMMENT = "cf-mailbox: Resend";
const unquote = (v: string) => v.replace(/^"|"$/g, "");

async function setupResendSending(env: Env, cf: Cf, domain: string, zoneId: string) {
  const d = await resendFindOrCreateDomain(env, domain);
  let created = 0;
  for (const rec of d.records ?? []) {
    const fqdn = resendRecordFqdn(domain, rec.name);
    const existing = await cf.dnsRecords(zoneId, rec.type, fqdn);
    const same = existing.some((r) => unquote(r.content) === unquote(rec.value));
    if (same) continue;
    // 以前接入 Resend 时留下的旧记录（重新添加后 DKIM 密钥会变）先删掉，避免同名多条导致签名验证失败
    for (const r of existing) if (r.comment === RESEND_COMMENT) await cf.del(`/zones/${zoneId}/dns_records/${r.id}`);
    await cf.post(`/zones/${zoneId}/dns_records`, {
      type: rec.type,
      name: fqdn,
      content: rec.value,
      ttl: 1,
      ...(rec.type === "MX" ? { priority: rec.priority ?? 10 } : {}),
      comment: RESEND_COMMENT,
    });
    created++;
  }
  if (d.status !== "verified") await resendApi(env, "POST", `/domains/${d.id}/verify`).catch(() => {});
  return {
    id: d.id,
    status: d.status === "verified" ? "active" : "pending",
    detail:
      d.status === "verified"
        ? "Resend 已验证"
        : `已写入 ${created} 条 DNS 记录，Resend 正在验证（通常几分钟），可稍后点「刷新状态」`,
  };
}

// 刷新发件状态（Resend 验证是异步的）
export async function refreshSendStatus(env: Env, domain: string): Promise<void> {
  const row = await env.DB.prepare("SELECT send_provider, send_meta, fallback_provider, fallback_meta FROM domains WHERE name = ?")
    .bind(domain)
    .first<{ send_provider: Provider; send_meta: string | null; fallback_provider: Provider | null; fallback_meta: string | null }>();
  if (!row) return;
  const resendStatus = async (meta: string) => {
    const d = await resendApi<{ status: string }>(env, "GET", `/domains/${JSON.parse(meta).resendDomainId}`);
    return { status: d.status === "verified" ? "active" : d.status === "failed" ? "error" : "pending", detail: `Resend 状态：${d.status}` };
  };
  if (row.send_provider === "resend" && row.send_meta) {
    const r = await resendStatus(row.send_meta);
    await env.DB.prepare("UPDATE domains SET send_status = ?, send_detail = ?, updated_at = ? WHERE name = ?").bind(r.status, r.detail, now(), domain).run();
  }
  if (row.fallback_provider === "resend" && row.fallback_meta) {
    const r = await resendStatus(row.fallback_meta);
    await env.DB.prepare("UPDATE domains SET fallback_status = ?, fallback_detail = ?, updated_at = ? WHERE name = ?").bind(r.status, r.detail, now(), domain).run();
  }
}

// ---------- 释放 Resend 名额 ----------
// Resend 没有"停用"状态，只能删除域名。顺带删掉本应用写入的 Resend DNS 记录，
// 主发件是 Resend 时：有可用的备用服务就把它提为主服务，否则这个域名改为"未开通"。
export async function releaseResend(env: Env, cf: Cf | null, domain: string): Promise<{ ok: boolean; detail: string; warning?: boolean }> {
  const row = await env.DB.prepare("SELECT zone_id, send_provider, fallback_provider, fallback_status, fallback_detail, fallback_meta FROM domains WHERE name = ?")
    .bind(domain)
    .first<{ zone_id: string; send_provider: Provider; fallback_provider: Provider | null; fallback_status: string | null; fallback_detail: string | null; fallback_meta: string | null }>();
  const found = (await resendDomains(env)).find((d) => d.name === domain);
  let removed = 0;
  let note = "";
  if (found) {
    // 删除前先取到它要求的 DNS 记录
    const full = await resendApi<ResendDomain>(env, "GET", `/domains/${found.id}`).catch(() => found);
    await resendApi(env, "DELETE", `/domains/${found.id}`);
    if (row && cf) {
      removed = await removeResendDns(cf, row.zone_id, domain, full.records ?? []).catch((e) => {
        note = `，但 DNS 记录未能清理（${e.message}）`;
        return 0;
      });
    } else if (row) note = "。DNS 记录需要重新登录 Cloudflare 后才能清理";
  }
  let after = "";
  if (row?.send_provider === "resend") {
    const promote = row.fallback_provider && row.fallback_provider !== "resend" && row.fallback_status && row.fallback_status !== "error";
    await env.DB.prepare(
      `UPDATE domains SET send_provider = ?, send_status = ?, send_detail = ?, send_meta = ?,
         fallback_provider = NULL, fallback_status = NULL, fallback_detail = NULL, fallback_meta = NULL, updated_at = ? WHERE name = ?`,
    )
      .bind(
        promote ? row.fallback_provider : "none",
        promote ? row.fallback_status : "none",
        promote ? row.fallback_detail : "已停用 Resend 发件",
        promote ? row.fallback_meta : null,
        now(),
        domain,
      )
      .run();
    after = promote ? "，之后改用 Cloudflare 发件" : "，这个域名暂时只能收信";
  } else if (row?.fallback_provider === "resend") {
    await env.DB.prepare("UPDATE domains SET fallback_provider = NULL, fallback_status = NULL, fallback_detail = NULL, fallback_meta = NULL, updated_at = ? WHERE name = ?")
      .bind(now(), domain)
      .run();
    after = "，已关闭备用发件";
  }
  if (!found) return { ok: true, detail: `${domain} 不在 Resend 账户中${after}` };
  return { ok: true, detail: `已从 Resend 删除 ${domain}，释放了 1 个名额${removed ? `，清理了 ${removed} 条 DNS 记录` : ""}${after}${note}`, warning: Boolean(note) };
}

// 删除 Resend 要求的记录（内容一致的），以及本应用以前写入的同名旧记录
export async function removeResendDns(cf: Cf, zoneId: string, domain: string, records: { name: string; type: string; value: string }[]): Promise<number> {
  const done = new Set<string>();
  for (const rec of records) {
    const existing = await cf.dnsRecords(zoneId, rec.type, resendRecordFqdn(domain, rec.name));
    for (const r of existing) {
      if (done.has(r.id) || (unquote(r.content) !== unquote(rec.value) && r.comment !== RESEND_COMMENT)) continue;
      await cf.del(`/zones/${zoneId}/dns_records/${r.id}`);
      done.add(r.id);
    }
  }
  return done.size;
}

// Resend 账户里的域名及其在本应用中的用途（设置页显示名额用量）
export async function resendUsage(env: Env) {
  const [list, { results }] = await Promise.all([
    resendDomains(env),
    env.DB.prepare("SELECT name, send_provider, fallback_provider FROM domains").all<{ name: string; send_provider: Provider; fallback_provider: Provider | null }>(),
  ]);
  const app = new Map(results.map((r) => [r.name, r]));
  return list.map((d) => {
    const r = app.get(d.name);
    return { name: d.name, status: d.status, inApp: Boolean(r), usage: r?.send_provider === "resend" ? "primary" : r?.fallback_provider === "resend" ? "backup" : null };
  });
}

// 定时任务：Resend 域名验证是异步的，自动刷新还在验证中的域名
export async function refreshPendingSending(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM domains WHERE (send_provider = 'resend' AND send_status = 'pending') OR (fallback_provider = 'resend' AND fallback_status = 'pending') LIMIT 10",
  ).all<{ name: string }>();
  for (const r of results) await refreshSendStatus(env, r.name).catch((e) => console.warn("refresh sending", r.name, e?.message));
}

// 从本应用移除域名：关闭 catch-all（不删除 MX，避免影响其他规则）
export async function removeDomain(env: Env, cf: Cf | null, domain: string, opts: { releaseResend?: boolean } = {}): Promise<{ restored: boolean; resend?: string }> {
  const row = await env.DB.prepare("SELECT zone_id FROM domains WHERE name = ?").bind(domain).first<{ zone_id: string }>();
  if (!row) return { restored: false };
  let resend: string | undefined;
  if (opts.releaseResend && (await resendKey(env))) {
    resend = await releaseResend(env, cf, domain).then(
      (r) => r.detail,
      (e) => `Resend 名额未能释放：${e.message}`,
    );
  }
  let restored = false;
  if (cf) {
    // 恢复配置前的 catch-all 规则；没有备份就停用
    const backup = await getSetting(env, `catchall_backup:${row.zone_id}`);
    if (backup) {
      const prev = JSON.parse(backup);
      await cf.put(`/zones/${row.zone_id}/email/routing/rules/catch_all`, {
        name: prev.name ?? "",
        enabled: prev.enabled ?? false,
        matchers: prev.matchers?.length ? prev.matchers : [{ type: "all" }],
        actions: prev.actions?.length ? prev.actions : [{ type: "drop" }],
      });
      restored = true;
    } else {
      await cf.put(`/zones/${row.zone_id}/email/routing/rules/catch_all`, { enabled: false, matchers: [{ type: "all" }], actions: [{ type: "drop" }] });
    }
  }
  await env.DB.prepare("DELETE FROM domains WHERE name = ?").bind(domain).run();
  return { restored, resend };
}

// ---------- 域名健康检查 ----------

export interface HealthItem {
  key: string;
  label: string;
  ok: boolean;
  detail?: string;
  fixable?: boolean;
}

export async function checkHealth(env: Env, cf: Cf, domain: string): Promise<HealthItem[]> {
  const row = await env.DB.prepare("SELECT zone_id, send_provider FROM domains WHERE name = ?").bind(domain).first<{ zone_id: string; send_provider: Provider }>();
  if (!row) throw new Error("域名不存在");
  const z = row.zone_id;
  const items: HealthItem[] = [];

  const routing = await cf.get<{ enabled: boolean; status: string; errors?: { code: string }[] }>(`/zones/${z}/email/routing`).catch(() => null);
  items.push({
    key: "routing",
    label: "Email Routing",
    ok: Boolean(routing?.enabled && routing.status === "ready"),
    detail: routing ? (routing.enabled ? (routing.status === "ready" ? "已开启" : `状态：${routing.status}${routing.errors?.length ? "（" + routing.errors.map((e) => e.code).join("、") + "）" : ""}`) : "未开启") : "无法读取",
    fixable: true,
  });

  const mx = await cf.dnsRecords(z, "MX", domain).catch(() => []);
  const foreign = mx.filter((r) => !isCfRoutingMx(r.content));
  items.push({
    key: "mx",
    label: "MX 记录",
    ok: mx.some((r) => isCfRoutingMx(r.content)) && !foreign.length,
    detail: foreign.length ? `存在其他邮件服务的 MX：${foreign.map((r) => r.content).join("、")}` : mx.length ? "指向 Cloudflare" : "缺失",
    fixable: !foreign.length,
  });

  const catchAll = await cf.get<{ enabled: boolean; actions: { type: string; value?: string[] }[] }>(`/zones/${z}/email/routing/rules/catch_all`).catch(() => null);
  const worker = await workerName(env);
  const caOk = Boolean(catchAll?.enabled && catchAll.actions?.some((a) => a.type === "worker" && a.value?.includes(worker)));
  items.push({ key: "catchall", label: "Catch-all → 本应用", ok: caOk, detail: caOk ? "正常" : "未指向本 Worker", fixable: true });

  const txt = await cf.dnsRecords(z, "TXT", domain).catch(() => []);
  const spf = txt.filter((r) => /v=spf1/i.test(r.content));
  items.push({
    key: "spf",
    label: "SPF（收件）",
    ok: spf.length === 1 && /_spf\.mx\.cloudflare\.net/i.test(spf[0].content),
    detail: spf.length > 1 ? "存在多条 SPF 记录，需手动合并" : spf.length ? spf[0].content.replace(/^"|"$/g, "") : "缺失",
    fixable: spf.length <= 1,
  });

  const dmarc = await cf.dnsRecords(z, "TXT", `_dmarc.${domain}`).catch(() => []);
  items.push({
    key: "dmarc",
    label: "DMARC",
    ok: dmarc.some((r) => /v=DMARC1/i.test(r.content)),
    detail: dmarc.length ? dmarc[0].content.replace(/^"|"$/g, "") : "缺失：建议添加，提升送达率并防止他人冒用你的域名",
    fixable: !dmarc.length,
  });

  if (row.send_provider === "cloudflare") {
    const preview = await cf.post<any>(`/zones/${z}/email/sending/subdomains/preview`, { name: domain }).catch(() => null);
    const records: any[] = preview?.records ?? preview?.dns_records ?? [];
    const missing = records.filter((r) => r.status === "missing" || r.missing === true);
    const conflicts = records.filter((r) => r.status === "conflict" || r.conflict);
    items.push({
      key: "sending",
      label: "发件 DNS（SPF / DKIM / 退信）",
      ok: Boolean(preview) && !missing.length && !conflicts.length,
      detail: !preview ? "无法读取" : conflicts.length ? `有 ${conflicts.length} 条冲突需手动处理` : missing.length ? `缺少 ${missing.length} 条记录` : "正常",
      fixable: Boolean(preview) && !conflicts.length,
    });
  } else if (row.send_provider === "resend") {
    items.push({ key: "sending", label: "发件（Resend）", ok: true, detail: "由 Resend 验证，可在域名卡片中刷新状态" });
  } else {
    items.push({ key: "sending", label: "发件服务", ok: false, detail: "未开通" });
  }
  return items;
}

export async function fixHealth(env: Env, cf: Cf, domain: string): Promise<HealthItem[]> {
  const row = await env.DB.prepare("SELECT zone_id, send_provider FROM domains WHERE name = ?").bind(domain).first<{ zone_id: string; send_provider: Provider }>();
  if (!row) throw new Error("域名不存在");
  const z = row.zone_id;
  const before = await checkHealth(env, cf, domain);
  const bad = new Set(before.filter((i) => !i.ok && i.fixable).map((i) => i.key));
  if (bad.has("routing") || bad.has("mx") || bad.has("spf")) await cf.post(`/zones/${z}/email/routing/dns`, {}).catch(() => {});
  if (bad.has("catchall")) {
    await cf.put(`/zones/${z}/email/routing/rules/catch_all`, {
      name: "cf-mailbox catch-all",
      enabled: true,
      matchers: [{ type: "all" }],
      actions: [{ type: "worker", value: [await workerName(env)] }],
    });
  }
  if (bad.has("dmarc")) {
    await cf.post(`/zones/${z}/dns_records`, { type: "TXT", name: `_dmarc.${domain}`, content: "v=DMARC1; p=none; adkim=r; aspf=r", ttl: 1, comment: "cf-mailbox: DMARC" }).catch(() => {});
  }
  if (bad.has("sending") && row.send_provider === "cloudflare") {
    const subs = await cf.get<{ tag: string; name: string }[]>(`/zones/${z}/email/sending/subdomains`).catch(() => []);
    const sub = subs.find((x) => x.name === domain);
    if (sub) await cf.post(`/zones/${z}/email/sending/subdomains/${sub.tag}/dns`).catch(() => {});
  }
  return checkHealth(env, cf, domain);
}
