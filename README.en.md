# CleanTempMail Workspace

<img src="public/brand/logo.svg" width="64" alt="logo" />

[中文](README.md) · [Deploy](#deploy) · [Update](#updating)

A self-hosted, multi-domain mailbox that runs entirely in your own Cloudflare account (a separate product from the public CleanTempMail disposable-mail service).

Sign in with Cloudflare, pick domains from your account, and inbound and outbound mail are set up in one click:

- **Catch-all by default**: `anything@your-domain` is delivered, with no mailboxes to create first
- **Multiple domains**: the sidebar groups mail by domain and address; addresses can have notes and colors
- **Reply from the receiving address**: mail sent to `sales@a.com` is answered from `sales@a.com`, with `In-Reply-To` / `References`
- **Choice of sending service**: Cloudflare Email Sending or Resend, chosen per domain, with automatic failover between them
- **Tracking protection on by default**: tracking pixels removed, remote images loaded through a privacy proxy, tracking parameters stripped from links

All data (D1 + R2) stays in your account. The UI is available in Chinese and English.

![Inbox](docs/english.png)

## Deploy

Takes about 15 minutes. Everything is created in your own Cloudflare account.

### Requirements

- A Cloudflare account, with the domains you want to receive mail on using Cloudflare DNS
- **R2** enabled once in the dashboard (free tier available)
- [Node.js](https://nodejs.org/) 20+ and git
- One of the following sending services (or both, as backups for each other):
  - **Cloudflare Email Sending**: requires Workers Paid ($5/month)
  - **Resend**: sign up at [resend.com](https://resend.com) and create an API key (free plan: 100 emails/day, 3,000/month)

### 1. Get the code

```bash
git clone https://github.com/cleantempmail/cleantempmail-workspace.git
cd cleantempmail-workspace
npm install
```

### 2. Set the app's address

In `wrangler.jsonc`, replace `web.cleantempmail.com` under `routes` with your own hostname, e.g. `mail.example.com`. It must be a hostname on a zone in your account; Cloudflare creates the DNS record and certificate automatically.

```jsonc
"routes": [{ "pattern": "mail.example.com", "custom_domain": true }],
```

To use a `*.workers.dev` address instead, delete the `routes` line and set `workers_dev` to `true`.

> Leave everything else as is. If you rename the Worker (`name`), set `vars.WORKER_NAME` to the same value: the catch-all rule delivers mail to the Worker by that name.

### 3. Deploy

```bash
npx wrangler login     # authorize wrangler in your browser
npm run deploy         # deploys the Worker, creates the D1 database and R2 bucket, then runs migrations
```

### 4. Set an encryption key (recommended)

Cloudflare credentials and the Resend API key are stored encrypted in D1. With `APP_SECRET` set, the key is kept separate from the data:

```bash
openssl rand -base64 32 | npx wrangler secret put APP_SECRET
```

Don't change or delete it afterwards, or stored credentials can no longer be decrypted (you'd need to sign in again and re-enter the Resend key).

### 5. Create the Cloudflare sign-in (OAuth client)

The admin signs in with their Cloudflare account. Create a **private** OAuth client in your account: only members of the account can authorize it, and no domain verification is needed.

In the Cloudflare dashboard, open **Manage Account → OAuth clients → Create client**:

| Field | Value |
|---|---|
| Redirect URL | `https://<your-app-address>/auth/callback` (must match exactly) |
| Response type | `Code` |
| Grant types | `Authorization Code`, `Refresh Token` |
| Token auth method | `Client Secret Basic` |
| Scopes | `user-details.read` `account-settings.read` `workers-scripts.metadata_read` `zone.read` `zone-settings.write` `dns.read` `dns.write` `email-routing-rule.read` `email-routing-rule.write` `email-sending.read` `email-sending.write` |
| Optional scope | `analytics.read`: shows "Delivered / Rejected" on sent mail. Everything else works without it |

Then store the client ID and secret as Worker secrets:

```bash
npx wrangler secret put CF_OAUTH_CLIENT_ID       # paste the Client ID
npx wrangler secret put CF_OAUTH_CLIENT_SECRET   # paste the Client Secret
```

<details>
<summary>Or create it with a script (needs an API token with OAuth Clients Write)</summary>

```bash
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
  ./scripts/create-oauth-client.sh https://<your-app-address>
```

The script creates the client and writes both secrets.
</details>

### 6. Sign in and add a domain

1. Open your app address and click "Sign in with Cloudflare". **The first person to sign in becomes the admin**
2. Go to **Domains → Add domain** and pick a domain from your account
3. The app turns on Email Routing, points the catch-all at this Worker, and sets up sending (Cloudflare if you have Workers Paid, otherwise Resend)

If the domain already uses another mail provider (e.g. Google Workspace MX records), you're asked to confirm before they're replaced, and the old records are backed up. DNS changes usually take a few minutes.

### 7. Optional

- **Send with Resend**: add your Resend API key under **Settings → Sending**, then choose Resend from the ⋮ menu on the domain card
- **Resend domain slots**: Resend's free plan allows 3 domains, and every domain in the account takes a slot whether or not it's verified or still used by this app. **Settings → Sending** shows the usage. For a domain you rarely send from, choose "Stop sending with Resend (free up a slot)" in its menu: it's deleted from Resend and its DNS records are removed, so the slot can go to another domain (setting it up again later rewrites the DNS records). Removing a domain offers the same option
- **Backup sending**: when both services are available, turn on the "Backup" switch on the domain card. If the primary service is out of quota, unverified or failing, mail goes out through the other one; messages over Cloudflare's 5 MB limit also go through Resend
- **Team members**: invite colleagues under **Settings → Team members**; they sign in with an emailed link and don't need a Cloudflare account
- **Push notifications**: turn on under **Settings → General** to get new-mail alerts even when the page is closed

### Updating

```bash
git pull
npm install
npm run update    # migrates the database first, then deploys, so mail keeps flowing during the update
```

### Troubleshooting

- **redirect_uri mismatch when signing in**: the OAuth client's Redirect URL must exactly match your app address, including `https://` and `/auth/callback`
- **Mail isn't arriving**: click "Health check" on the domain card. It checks Email Routing, MX, catch-all, SPF and DMARC and can fix them in one click
- **Cloudflare sending fails**: usually the account doesn't have Workers Paid. Switch to Resend, or set Resend as the backup
- **Resend says the domain slots are full**: the free plan allows 3 domains. Free one up (see step 7) or upgrade your Resend plan. With many domains, Workers Paid with Cloudflare sending is simpler: 3,000 emails/month included and no limit on the number of domains
- **AI features unavailable**: summaries, translation and reply drafts use Workers AI, which has a daily free allowance

## Plans

| | Workers Free | Workers Paid ($5/month) |
|---|---|---|
| Receiving (Email Routing + Worker) | ✅ (very large messages may exceed CPU limits; the raw message is still kept) | ✅ |
| Cloudflare Email Sending to any recipient | ❌ | ✅ (beta; new accounts start with a low daily quota) |
| Sending through Resend | ✅ | ✅ |
| Workers AI | Daily free allowance | Daily free allowance + pay as you go |

Limits: 50 recipients per message; outgoing size 5 MiB with Cloudflare / 20 MiB with Resend; incoming up to 25 MiB.

## Local development

```bash
printf 'DEV_LOGIN=1\n' > .dev.vars      # local requests only: skips OAuth
npm run db:local
npm run dev
# simulate inbound mail:
curl -X POST "http://localhost:8787/cdn-cgi/handler/email?from=a@gmail.com&to=hi@example.com" --data-binary @test.eml
```

See [README.md](README.md) for the full feature list, security notes and code layout (in Chinese).

## License

[MIT](LICENSE)
