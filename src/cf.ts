// 极简 Cloudflare API 客户端，用登录用户的 OAuth access token 调用
const API = "https://api.cloudflare.com/client/v4";

export class CfApiError extends Error {
  constructor(
    public status: number,
    public errors: { code: number; message: string }[],
  ) {
    super(errors.map((e) => `${e.message} (${e.code})`).join("; ") || `HTTP ${status}`);
  }
}

export class Cf {
  constructor(public readonly token: string) {}

  async req<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    return (await this.raw(method, path, body)).result as T;
  }

  private async raw(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
      throw new CfApiError(res.status, data.errors ?? [{ code: res.status, message: res.statusText }]);
    }
    return data;
  }

  // 自动翻页，取全部结果
  async all<T = any>(path: string, perPage = 50): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; ; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const data = await this.raw("GET", `${path}${sep}per_page=${perPage}&page=${page}`);
      out.push(...data.result);
      const totalPages = data.result_info?.total_pages ?? 1;
      if (page >= totalPages || !data.result.length) return out;
    }
  }

  get = <T = any>(path: string) => this.req<T>("GET", path);
  post = <T = any>(path: string, body: unknown = {}) => this.req<T>("POST", path, body);
  put = <T = any>(path: string, body: unknown) => this.req<T>("PUT", path, body);
  del = <T = any>(path: string) => this.req<T>("DELETE", path);

  user() {
    return this.get<{ id: string; email: string }>("/user");
  }

  accounts() {
    return this.all<{ id: string; name: string }>("/accounts");
  }

  async workerExists(accountId: string, name: string): Promise<boolean> {
    const scripts = await this.get<{ id: string }[]>(`/accounts/${accountId}/workers/scripts`);
    return scripts.some((s) => s.id === name);
  }

  zones(accountId: string) {
    return this.all<{ id: string; name: string; status: string; account: { id: string } }>(
      `/zones?account.id=${accountId}&status=active`,
    );
  }

  zone(zoneId: string) {
    return this.get<{ id: string; name: string; account: { id: string } }>(`/zones/${zoneId}`);
  }

  dnsRecords(zoneId: string, type: string, name: string) {
    return this.get<{ id: string; type: string; name: string; content: string; priority?: number; comment?: string | null }[]>(
      `/zones/${zoneId}/dns_records?type=${type}&name=${encodeURIComponent(name)}&per_page=100`,
    );
  }
}
