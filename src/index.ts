import { Hono } from "hono";
import { api } from "./api";
import { auth, csrf } from "./auth";
import { daily, everyMinute } from "./cron";
import type { AppEnv, Env } from "./env";
import { handleInbound } from "./mail";
import { noteStorageMode, noteWorkerHost } from "./util";

const app = new Hono<AppEnv>();
app.use("/api/*", async (c, next) => {
  const p = noteWorkerHost(c.env, new URL(c.req.url).hostname);
  if (p) c.executionCtx.waitUntil(p);
  const m = noteStorageMode(c.env);
  if (m) c.executionCtx.waitUntil(m);
  await next();
});
app.use("/api/*", csrf);
app.use("/auth/*", csrf);
app.route("/auth", auth);
app.route("/api", api);
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  // Email Routing 的 catch-all 把所有已配置域名的邮件投递到这里
  async email(message, env, ctx) {
    await handleInbound(message, env, ctx);
  },
  // 每分钟：定时发送、稍后提醒、投递状态；每天 03:17 UTC：清理
  async scheduled(event, env, ctx) {
    ctx.waitUntil(event.cron === "17 3 * * *" ? daily(env) : everyMinute(env));
  },
} satisfies ExportedHandler<Env>;
