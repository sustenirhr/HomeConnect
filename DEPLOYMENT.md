# Deploying Kazinyumbani

A checklist for putting the site online safely. The first section is already handled in the code;
everything after it is set up on the server when you host.

## Already handled in the code

- **Passwords** are hashed with scrypt and a per-user salt. Hashing runs off the main thread, so logins don't slow the site down for everyone else.
- **Login and sign-up rate limits:** 10 wrong passwords per phone number per 15 minutes, 100 login attempts and 30 sign-ups per hour per IP address. Chat is limited to 30 messages a minute per user.
- **Sessions** use random 256-bit tokens in an `HttpOnly`, `SameSite=Lax` cookie (also `Secure` in production). Only a hash of each token is stored, so a copy of the database can't be used to log in. Expired sessions are deleted every hour.
- **Security headers** on every response: Content-Security-Policy (blocks injected scripts), X-Frame-Options (no embedding in other sites), nosniff, Referrer-Policy, Permissions-Policy, and HSTS in production.
- **Private data:** ID numbers are never shown to anyone else. Phone numbers, referee numbers and the good-conduct certificate only appear after both sides accept. Photos and certificates are served from login-protected URLs that check who is asking.
- **Input checks:** every API input is validated and length-limited, SQL uses bound parameters, all user text is escaped before it is shown, requests are capped at 3 MB, and the API only accepts JSON (which blocks cross-site form attacks).
- **Performance:** browse lists no longer embed images (each photo is a cached URL), static files are gzipped and cached with ETags, the database has indexes for every common query, chat polling pauses while the app is in the background, and the first chat load returns only the latest 200 messages.
- **Phone verification:** sign-up needs a 6-digit code texted to the number. Codes expire after 10 minutes, are stored only as hashes, stop working after 5 wrong guesses, and a number can request at most 3 codes per 15 minutes (texts cost money).
- **Password reset** by texted code logs out every other device. The reset screen responds the same way whether or not a number has an account.
- **Account deletion** (Profile → Delete account, password required) erases the profile, photos, matches, vacancies, applications and chats.
- **Report and block** from any chat. Blocking works both ways: the two people disappear from each other's browse, shortlist, requests, vacancies and chats. People can unblock from their profile.
- **Reliability:** `/healthz` reports whether the app and database are up. The server times out slow clients and shuts down cleanly on restart (`SIGTERM`).

## Before going live

- [ ] **Choose a host with a permanent disk.** The database is a single SQLite file, so use a VPS (for example DigitalOcean, Hetzner, Linode, AWS Lightsail or a Kenyan provider) or a platform with a persistent volume (Fly.io volume, Railway volume). Avoid hosts with temporary disks (Vercel, Netlify, Render's free tier, Heroku): they wipe the database on every restart.
- [ ] **Install Node.js 22.13 or newer** (the app uses the built-in `node:sqlite`).
- [ ] **Serve over HTTPS only.** Put Caddy (automatic certificates), nginx with Let's Encrypt, or Cloudflare in front of the app, and redirect `http://` to `https://`.
- [ ] **Set the environment variables:**
  ```
  NODE_ENV=production   # Secure cookies + HSTS
  TRUST_PROXY=1         # only when behind Caddy/nginx/Cloudflare, so rate limits see real visitor IPs
  PORT=3000
  DB_PATH=/var/lib/kazinyumbani/kazinyumbani.db   # outside the app folder
  AT_USERNAME=your-africastalking-username        # SMS codes; see below
  AT_API_KEY=your-africastalking-api-key
  AT_SENDER_ID=KAZINYUMBANI                       # optional, once approved
  ```
- [ ] **Set up SMS.** Create an [Africa's Talking](https://africastalking.com) account, top up airtime, and put the username and API key in the settings above. Test first with `AT_USERNAME=sandbox` and the sandbox key in their simulator. A sender ID (so texts come from "KAZINYUMBANI" rather than a number) is applied for in their dashboard. Without these settings, production sign-ups and resets fail; locally, codes are printed in the server console instead.
- [ ] **Check reports regularly.** On the server, run `npm run admin` to list open reports, `npm run admin -- resolve <id>` once dealt with, and `npm run admin -- delete <phone>` to remove an abusive account. Each report shows how many times that number has been reported.
- [ ] **Keep the app port private.** Firewall everything except 80, 443 and SSH; only the reverse proxy should reach port 3000. Use SSH keys, not passwords.
- [ ] **Lock down the database file** so only the app's user can read it (`chmod 600`), and use an encrypted disk if your host offers it. The file contains ID numbers and phone numbers.
- [ ] **Never run `npm run seed` in production.** If demo accounts (password `demo1234`, phones `0700000001`–`0700000006` and `0700000100`) ever reach the live database, delete them.
- [ ] **Run the app under a process manager** (systemd or pm2) so it restarts after crashes and server reboots.
- [ ] **Back up the database every day, off the server.** Use `sqlite3 kazinyumbani.db ".backup backup.db"` from a cron job or [Litestream](https://litestream.io) for continuous backups. Encrypt the backups, and test a restore at least once.
- [ ] **Monitor uptime:** point a free uptime checker (UptimeRobot, Better Stack) at `https://yourdomain/healthz`.
- [ ] **Consider Cloudflare's free plan** in front of the site for DDoS protection and extra rate limiting.

## How far this setup scales

One Node process with SQLite (WAL mode) handles thousands of active users and many thousands of
registered profiles for an app like this, on a small VPS (2 vCPU / 2–4 GB RAM). The busiest traffic is
chat polling (every 4 seconds per open chat), which hits indexed queries and only writes when there's something new.

Signs you're outgrowing it, and the next step for each:

- **Response times climb under load:** move to a bigger VPS first; it's the cheapest fix.
- **You need more than one server:** move the data to PostgreSQL, the rate-limit counters to Redis, and photos to object storage (S3, Cloudflare R2). Rate limits are currently kept in memory, so they're per process.
- **Chat feels slow or polling load grows:** switch chat to WebSockets or Server-Sent Events.

## Still to do (not yet built)

- [ ] **Kenya Data Protection Act 2019:** register with the Office of the Data Protection Commissioner (ODPC) as a data controller, since the site stores ID numbers, photos and family details. Publish a privacy policy and ask for consent at sign-up.
- [ ] **A web admin page** for reports, if checking them from the command line becomes a chore.
- [ ] **Encrypt ID numbers** in the database with a key kept outside it, if your risk assessment calls for it.
