# PC Savings Tracker

A small account-based savings tracker with:
- Username + self-created access code (no email/phone)
- Scrypt-hashed access codes
- Server-side sessions stored in SQLite
- Per-account PC and secondary balances
- Server-calculated savings allocations and transaction history
- Credential changes verified with the previous access code
- Manual website update notification using `public/version.json`

## Important behavior

PC goal: Rp10,000,000. Secondary threshold: Rp150,000.

For each incoming amount:
1. If the secondary balance plus incoming money is below Rp150,000, all incoming money goes to secondary.
2. If the threshold is reached, fill only the amount needed to reach Rp150,000.
3. Split that Rp150,000 into Rp75,000 added to PC and Rp75,000 retained in secondary.
4. Send every remaining rupiah from that same incoming amount directly to PC.
5. Do not refill secondary with that remaining amount.

Example: secondary starts at Rp140,000 and incoming is Rp100,000. Rp10,000 fills secondary, Rp75,000 from the split goes to PC, and the remaining Rp90,000 goes to PC. PC receives Rp165,000; secondary ends at Rp75,000.

## Run locally

Requires Node.js 20 or newer.

1. Copy `.env.example` to `.env`.
2. Set `SESSION_SECRET` to a long random secret (at least 32 characters).
3. Install dependencies: `npm install`
4. Start: `npm start`
5. Open `http://localhost:3000`

The SQLite database and session store are created in `DATA_DIR` (default `./data`).

## Deploying online

This is a backend application, not a single static HTML file. Deploy it to a Node.js host that supports HTTPS and a persistent disk/volume.

Set these environment variables on the host:
- `NODE_ENV=production`
- `SESSION_SECRET` (long random secret; keep it private)
- `DATA_DIR` (path on the persistent mounted disk)
- `PORT` (usually supplied by the host)

Do not deploy with an ephemeral filesystem: accounts and transactions would be lost when the host restarts or redeploys. Enable HTTPS. Back up the persistent `data` directory regularly. Do not commit `.env`, database files, or secrets to source control.

## Account recovery limitation

Because registration deliberately does not collect an email or phone number, there is no email-based password reset. If a user forgets their access code, they cannot change it through the normal account settings because the previous code is required. Before using this with important records, decide on a safe recovery process and keep backups. Never share access codes.

## Manual website updates

Update the frontend files and `public/version.json`, then deploy the new release. For example, change the version from `1.0.0` to `1.1.0` and add concise changelog entries. Signed-in users' browsers check for a newer version and show a prompt. Selecting **Later** keeps the current page open; selecting **Update now** reloads the deployed website. The database is separate from frontend files, so a normal frontend-only update does not replace account records.

If a future release changes the database schema, create and test a backward-safe database migration and take a backup before deploying it. This starter project intentionally does not auto-run arbitrary migrations.

## Security and scope notes

- Access codes are stored as salted scrypt hashes, never as plaintext.
- Session cookies are HttpOnly and SameSite=Lax; production cookies are Secure and require HTTPS.
- Login/registration endpoints are rate-limited.
- User data queries are scoped to the authenticated account.
- This is a starter implementation. Before real-world production use, have the deployment and security configuration reviewed, add monitoring and tested backups, and decide on an account-recovery policy.
- There is no email verification, MFA, account deletion UI, or cross-device session management UI in this first version.
