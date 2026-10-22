-- 不依赖 OAuth 的管理员登录：密码 + 通行密钥（WebAuthn）
CREATE TABLE IF NOT EXISTS passkeys (
  id TEXT PRIMARY KEY,                 -- 凭据 id（base64url）
  user_id TEXT NOT NULL,
  public_key TEXT NOT NULL,            -- JWK
  alg INTEGER NOT NULL,                -- -7 ES256 / -257 RS256
  sign_count INTEGER NOT NULL DEFAULT 0,
  name TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

-- 通行密钥的一次性 challenge
CREATE TABLE IF NOT EXISTS auth_challenges (
  challenge TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                  -- register | login
  expires_at INTEGER NOT NULL
);

-- 登录失败次数（按 IP 和全局限流）
CREATE TABLE IF NOT EXISTS auth_attempts (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
