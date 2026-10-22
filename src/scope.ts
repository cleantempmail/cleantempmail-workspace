// 访问范围：管理员看全部；团队成员只能看到被授权的域名 / 地址
import type { Env, Scope, Session } from "./env";
import { domainOf, placeholders } from "./util";

export const FULL: Scope = { all: true, domains: [], addresses: [] };

export function canUseAddress(scope: Scope, address: string): boolean {
  if (scope.all) return true;
  const a = address.toLowerCase();
  return scope.addresses.includes(a) || scope.domains.includes(domainOf(a));
}

export function canUseDomain(scope: Scope, domain: string): boolean {
  return scope.all || scope.domains.includes(domain.toLowerCase());
}

// 用于 messages 表（可加别名）
export function messageScopeSql(scope: Scope, alias = ""): { sql: string; args: string[] } {
  if (scope.all) return { sql: "1=1", args: [] };
  const p = alias ? alias + "." : "";
  const parts: string[] = [];
  const args: string[] = [];
  if (scope.domains.length) {
    parts.push(`${p}domain IN (${placeholders(scope.domains.length)})`);
    args.push(...scope.domains);
  }
  if (scope.addresses.length) {
    parts.push(`${p}mailbox IN (${placeholders(scope.addresses.length)})`);
    args.push(...scope.addresses);
  }
  return { sql: parts.length ? `(${parts.join(" OR ")})` : "0", args };
}

// 用于 threads 表（domains / mailboxes 是逗号包围的列表）
export function threadScopeSql(scope: Scope, alias = "t"): { sql: string; args: string[] } {
  if (scope.all) return { sql: "1=1", args: [] };
  const parts: string[] = [];
  const args: string[] = [];
  for (const d of scope.domains) {
    parts.push(`${alias}.domains LIKE ?`);
    args.push(`%,${d},%`);
  }
  for (const a of scope.addresses) {
    parts.push(`${alias}.mailboxes LIKE ?`);
    args.push(`%,${a},%`);
  }
  return { sql: parts.length ? `(${parts.join(" OR ")})` : "0", args };
}

export async function messageInScope(env: Env, session: Session, id: string): Promise<boolean> {
  if (session.scope.all) return true;
  const s = messageScopeSql(session.scope);
  const row = await env.DB.prepare(`SELECT 1 FROM messages WHERE id = ? AND ${s.sql}`).bind(id, ...s.args).first();
  return Boolean(row);
}

export function parseScope(json: string | null | undefined): Scope {
  try {
    const s = JSON.parse(json || "{}");
    return {
      all: Boolean(s.all),
      domains: (s.domains ?? []).map((x: string) => x.toLowerCase()),
      addresses: (s.addresses ?? []).map((x: string) => x.toLowerCase()),
    };
  } catch {
    return { all: false, domains: [], addresses: [] };
  }
}
