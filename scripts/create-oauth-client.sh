#!/usr/bin/env bash
# 在你自己的 Cloudflare 账户里创建一个私有 OAuth 客户端，并写入 Worker Secret。
#
# 用法：
#   CLOUDFLARE_API_TOKEN=<有 "OAuth Clients Write" 权限的 token> \
#   CLOUDFLARE_ACCOUNT_ID=<账户 ID> \
#   ./scripts/create-oauth-client.sh https://cf-mailbox.<你的子域>.workers.dev
set -euo pipefail

APP_URL="${1:?用法：$0 <应用网址，例如 https://cf-mailbox.xxx.workers.dev>}"
APP_URL="${APP_URL%/}"
: "${CLOUDFLARE_API_TOKEN:?请设置 CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?请设置 CLOUDFLARE_ACCOUNT_ID}"

# 与 src/auth.ts 中的 SCOPES 保持一致（offline_access 由 refresh_token 授权类型自动带上）
SCOPES='["user-details.read","account-settings.read","workers-scripts.metadata_read","zone.read","zone-settings.write","dns.read","dns.write","email-routing-rule.read","email-routing-rule.write","email-sending.read","email-sending.write","analytics.read"]'
# analytics.read 用于显示外发邮件的投递状态，设为可选：授权时可以取消勾选
OPTIONAL_SCOPES='["analytics.read"]'

RESP=$(curl -sS -X POST "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/oauth_clients" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"client_name\": \"cf-mailbox\",
    \"grant_types\": [\"authorization_code\", \"refresh_token\"],
    \"response_types\": [\"code\"],
    \"token_endpoint_auth_method\": \"client_secret_basic\",
    \"redirect_uris\": [\"${APP_URL}/auth/callback\"],
    \"scopes\": ${SCOPES},
    \"optional_scopes\": ${OPTIONAL_SCOPES}
  }")

CLIENT_ID=$(echo "$RESP" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);if(!r.success){console.error(JSON.stringify(r.errors));process.exit(1)}process.stdout.write(r.result.client_id)})')
CLIENT_SECRET=$(echo "$RESP" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).result.client_secret))')

echo "已创建 OAuth 客户端：${CLIENT_ID}"
printf '%s' "$CLIENT_ID" | npx wrangler secret put CF_OAUTH_CLIENT_ID
printf '%s' "$CLIENT_SECRET" | npx wrangler secret put CF_OAUTH_CLIENT_SECRET
echo "完成。打开 ${APP_URL} 用 Cloudflare 账户登录即可。"
