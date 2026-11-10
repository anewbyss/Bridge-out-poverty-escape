# Security guide

Some of the young people who use this app, and some past clients, are skilled with computers. Assume that someone **will** try to:
- get into staff accounts,
- guess check-in codes to read another young person's record,
- find out where a specific young person is staying, or
- flood the system.

This guide lists what the app does about it, and what **you** must do when running it.

## Built into the app

| Threat | Protection |
|---|---|
| Password guessing | Per-person accounts. scrypt-hashed passwords (min. 12 chars, common words refused). Lockout after 5 misses per account+IP, 15 per IP, and 50 per account from anywhere. Lockouts can't be used to block real staff from other places. |
| Stolen password | Two-step sign-in (authenticator app) is **required** for Main architect and Maintenance roles, and can be required for everyone (Settings → Security). Codes can't be reused. A stolen session can't swap in a new authenticator. |
| Stolen session / left-open laptop | Signed cookies (`HttpOnly`, `SameSite=Strict`, `__Host-` prefix and `Secure` on HTTPS). 30-minute idle timeout, 8-hour maximum. "Sign out everywhere". Changing a password, role or active status ends old sessions. |
| Too much access | Roles with least privilege (`server/roles.js`). Program staff only see and edit their own program and the Refer-me requests sent to it. Only architects can manage architects. The last architect can't be removed. |
| Insider misuse | The audit log records sign-ins, failures, lockouts, every youth record opened, exports, account and setting changes. It is read-only in the app. |
| Check-in code guessing | Codes are 8 characters from a 32-character alphabet (~1 trillion combinations). After 20 wrong codes in an hour, that address is blocked for an hour and an alert is logged. |
| Database file theft | Contact details, names and notes are encrypted with AES-256-GCM when `DATA_KEY` is set. Old records are deleted on a schedule. |
| Email interception | Refer-me emails contain **no** contact details by default ("Minimal"). |
| Spam / flooding | Per-IP limits on intake, screener and Refer-me, a global Refer-me limit, a honeypot field, and a 64 KB body limit. |
| Web attacks | Strict Content-Security-Policy (no inline or third-party scripts), no `innerHTML` anywhere (all text is inserted as text), parameterized SQL only, JSON-only writes plus Origin check (CSRF), `X-Frame-Options: DENY`, COOP/CORP, HSTS on HTTPS, path-traversal-safe static files, no dependencies at runtime. |
| Admin panel discovery | `STAFF_ALLOWED_IPS` makes the staff API return "Not found" except from listed addresses. |

## You must do these before going live

1. **HTTPS only.** Put the app behind a TLS-terminating reverse proxy (Caddy, nginx or a managed host). Set `SECURE_COOKIES=1`. If the proxy sets `X-Forwarded-For`, set `TRUST_PROXY=1` so rate limits see real addresses. Never expose port 3000 directly.
2. **Secrets**: generate each one with
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   - `SESSION_SECRET`: one value.
   - `DATA_KEY`: a **different** value. Store it in your host's secret manager or a password manager, **not** next to the database or in its backups. If you lose it, encrypted fields can't be recovered.
   - Never commit `.env` (it's already in `.gitignore`).
3. **First architect**: start once with `ADMIN_EMAIL=you@yourorg.org` and **no** `STAFF_PASSWORD`. Sign in with the one-time password printed on the console, then choose your own password and set up two-step sign-in. Then remove any `STAFF_PASSWORD` from the environment.
4. **Accounts**: one per person, with the smallest role that works. Disable accounts the same day someone leaves.
5. **Password resets**: confirm identity **in person or by calling a known number**, never because of an email, text or DM alone. "I'm staff and I'm locked out, can you reset me?" is the most common way in. Hand over temporary passwords in person or by phone.
6. **Staff network**: if staff work from known places, set `STAFF_ALLOWED_IPS` (comma-separated exact IPs, or prefixes ending in `.` like `10.20.`).
7. **The staff Gmail** (`ripchoom@gmail.com` or whatever you set): turn on Google 2-Step Verification, use an **App Password** only for `SMTP_PASS`, don't auto-forward it, and limit who can sign in. Keep Refer-me emails on "Minimal".
8. **Backups**: encrypt them (for example with `age` or 7-Zip AES), keep them off the server, store the key separately, and test a restore. The `.db` file holds youth records.
9. **Updates**: keep Node.js on a supported LTS release (`node -v`) and apply security updates to the server OS.
10. **Review weekly**: Staff → Audit log. Look for `security.*`, `login.locked`, sign-ins at odd hours, and youth records opened by someone with no reason to.

## The phone app

The Home Screen app keeps all records on one staff phone, protected by a passcode, with no accounts. Treat that phone like a filing cabinet:
- device passcode + Face ID,
- Find My / remote wipe turned on,
- backups encrypted,
- never lent out.

For multi-person teams, use the server version.

## If you suspect a breach

1. Staff → Staff accounts: disable the affected accounts, and use **Reset password** for everyone who may be exposed.
2. Change `SESSION_SECRET` and restart. This signs everyone out.
3. Save the audit log and server logs before anything is cleaned up.
4. If personal information may have been accessed, Oregon law (ORS 646A.604) requires notifying affected people and, if over 250 Oregonians are affected, the Oregon Attorney General. Get legal help quickly. Notices have deadlines.
5. Fix the cause before reopening.

## Reporting vulnerabilities

See `/security` in the app: good-faith rules plus a contact address. Channel curious young people there instead of into the system.
