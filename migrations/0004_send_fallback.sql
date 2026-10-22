-- 备用发件：主发件服务明确拒发（额度用完、未验证、服务异常等）或邮件超过主服务大小上限时，自动改用另一个服务
ALTER TABLE domains ADD COLUMN fallback_provider TEXT;   -- cloudflare | resend，NULL 表示未启用
ALTER TABLE domains ADD COLUMN fallback_status TEXT;     -- active | pending | error
ALTER TABLE domains ADD COLUMN fallback_detail TEXT;
ALTER TABLE domains ADD COLUMN fallback_meta TEXT;       -- Resend 的 { resendDomainId }
