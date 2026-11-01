# Putting the Linck API on DigitalOcean

This is the plan you approved (LIN-21), as steps to follow once. The web app stays
on Vercel. The API runs on DigitalOcean in Bangalore (BLR1):

```
browser ──▶ https://<vercel domain>/            the web app (Vercel)
        └─▶ https://<vercel domain>/api/...     Vercel passes it on ──▶ the API (App Platform)
                                                                         ├─▶ PostgreSQL 16 (managed)
                                                                         └─▶ Spaces bucket (bill photos)
```

The browser only ever talks to your Vercel domain. That keeps the sign-in cookie
simple and safe, and the API needs no special settings for it.

**You will need:** a card for DigitalOcean, the Google account that will own sign-in,
access to the Vercel project, and a computer with this repository, Python 3 and
`uv` (install `uv` with `curl -LsSf https://astral.sh/uv/install.sh | sh`).

**Keep a private note** (a password manager is best) for the values marked 🔑. They
are passwords. Never put them in GitHub, in a chat, or in `.do/app.yaml`.

Screens change from time to time. If a button has a slightly different name, look
for the nearest match.

---

## 1. Create the account and the project

1. Go to <https://cloud.digitalocean.com> and sign up. Confirm your email. Add your card.
2. In the left menu, click **Projects**, then **New Project**.
3. Name: `Linck`. Click **Create Project**. If it offers to move resources in, click **Skip**.

## 2. Create the Spaces bucket for files

Bill photos and WhatsApp slips are kept here. The API's own disk is wiped on every
deploy, so files cannot live there.

1. Left menu: **Spaces Object Storage** → **Create Bucket**.
2. Region: **Bangalore (BLR1)**.
3. CDN: leave it **off**.
4. Name: something unique, such as `linck-files-<your company>`. Write it down: this is the **bucket name**.
5. Project: **Linck**. Click **Create**. (The first bucket starts a monthly Spaces subscription.)
6. Open the bucket, then its **Settings** tab. Make sure **File Listing** is **Restricted**.
   Never make the bucket or a file public: the API hands files out itself, after checking who is asking.
7. Back in **Spaces Object Storage**, open the **Access Keys** tab → **Create Access Key**.
   - If it offers **Limited Access**, choose it, pick only this bucket, and allow **Read/Write/Delete**.
   - Name: `linck-api`.
8. Copy both values now; the secret is shown only once:
   - 🔑 **Access Key ID** → becomes `LINCK_S3_ACCESS_KEY_ID`
   - 🔑 **Secret Key** → becomes `LINCK_S3_SECRET_ACCESS_KEY`

## 3. Create the database

1. Left menu: **Databases** → **Create Database Cluster**.
2. Region: **Bangalore (BLR1)**.
3. Engine: **PostgreSQL**, version **16**.
4. Plan: the smallest is fine to start. (A standby node, for automatic failover, can be added later.)
5. Cluster name: `linck-db`. Use exactly this: `.do/app.yaml` refers to it.
6. Project: **Linck**. Click **Create Database Cluster**. It takes a few minutes.
7. When it is ready, open the cluster's **Settings** tab → **Trusted sources** → **Edit**.
   Add your computer's public IP address (search the web for "what is my IP"). **Save**.
   Once this list has entries, only what is on it can reach the database.
8. **Users & Databases** tab → **Add new database**. Name: `linck`. **Save**.
9. **Overview** tab → **Connection details**. Choose **Public network** and **Connection string**.
   Click **show** to reveal the password, then copy the whole line. It looks like
   `postgresql://doadmin:...@db-linck-db-....db.ondigitalocean.com:25060/defaultdb?sslmode=require`.
   - 🔑 This is the **admin connection string**. Use it only in step 4, only on your computer.

## 4. Create the database roles (once)

The API never connects as `doadmin`. This step creates its own, weaker roles. It
needs no superuser, so it works on a managed cluster.

1. On your computer, open a terminal in the repository, then:
   ```sh
   cd apps/api
   export LINCK_ADMIN_URL='<the admin connection string from step 3.9>'
   export LINCK_MIGRATOR_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
   export LINCK_APP_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
   uv run python scripts/bootstrap_roles.py --database linck --print-urls
   ```
2. It should end with `ok: ...`, then print two lines. Copy both:
   - 🔑 `LINCK_DATABASE_URL=postgresql+asyncpg://linck_app:...?ssl=require`
   - 🔑 `LINCK_MIGRATION_DATABASE_URL=postgresql+psycopg://linck_migrator:...?sslmode=require`

   Copy them exactly. The two drivers spell the SSL part differently (`ssl=` and
   `sslmode=`); swapping them stops the API from starting.
3. Close the terminal, so the passwords are not left in it.

If it says `PROBLEM` or `refused`, it tells you what to fix. It is safe to run again.

## 5. Make the session secret

1. Run `python3 -c 'import secrets; print(secrets.token_urlsafe(48))'`.
2. 🔑 Copy the result → becomes `LINCK_SESSION_SECRET`. It signs everyone's sign-in cookie.

## 6. Set up Google sign-in

1. Go to <https://console.cloud.google.com>. Create a project named `Linck`, or pick one.
2. Open **Google Auth Platform** (older screens: **APIs & Services → OAuth consent screen**). Click **Get started**.
   - App name: `Linck`. Support email: yours.
   - Audience: **Internal** if everyone signs in with your Google Workspace; otherwise **External**.
   - Contact email: yours. Agree, then **Create**.
   - If you chose External, open **Audience** and click **Publish app**. Linck asks only for name, email and photo.
3. Open **Clients** (older screens: **Credentials → Create credentials → OAuth client ID**) → **Create client**.
   - Application type: **Web application**. Name: `Linck`.
   - **Authorized redirect URIs** → **Add URI**:
     `https://<vercel domain>/api/auth/google/callback`
     (your real domain, such as `linck.vercel.app`; https, no slash at the end).
   - Leave **Authorized JavaScript origins** empty. Click **Create**.
4. Copy both:
   - **Client ID** → becomes `LINCK_GOOGLE_CLIENT_ID`
   - 🔑 **Client secret** → becomes `LINCK_GOOGLE_CLIENT_SECRET`

## 7. Create the app

App Platform builds the API from GitHub using `.do/app.yaml`. You create it once
with DigitalOcean's command-line tool, `doctl`.

1. Let DigitalOcean see the repository: left menu **App Platform** → **Create App** → **GitHub**.
   Follow the link to install DigitalOcean's GitHub app, and give it access to
   `KumarBalajiNagaraj/linck`. Then leave this screen; nothing else is needed here.
2. Make an API token: left menu **API** → **Tokens** → **Generate New Token**. Name `doctl`,
   a short expiry, **Full Access**. 🔑 Copy it.
3. Install `doctl` (on a Mac: `brew install doctl`; otherwise see
   <https://github.com/digitalocean/doctl/releases>). Run `doctl auth init` and paste the token.
   When the app is running, delete the token (**API** → **Tokens**); it is not needed again.
4. In the repository folder, run `doctl projects list` and copy the ID of `Linck`. Then:
   ```sh
   doctl apps create --spec .do/app.yaml --project-id <the Linck project ID>
   ```
5. The first deploy **fails**. That is expected: the passwords are not in yet.
6. Open the app: left menu **App Platform** → **linck-api** → **Settings**.
   Click the **api** component → **Environment Variables** → **Edit**, and fill in:

   | Key | Value |
   |---|---|
   | `LINCK_DATABASE_URL` 🔑 | the first line from step 4.2 |
   | `LINCK_SESSION_SECRET` 🔑 | from step 5 |
   | `LINCK_WEB_APP_URL` | `https://<vercel domain>` (no slash at the end) |
   | `LINCK_OAUTH_REDIRECT_URL` | `https://<vercel domain>/api/auth/google/callback` (as in step 6.3) |
   | `LINCK_GOOGLE_CLIENT_ID` | from step 6.4 |
   | `LINCK_GOOGLE_CLIENT_SECRET` 🔑 | from step 6.4 |
   | `LINCK_S3_BUCKET` | the bucket name from step 2.4 |
   | `LINCK_S3_ACCESS_KEY_ID` 🔑 | from step 2.8 |
   | `LINCK_S3_SECRET_ACCESS_KEY` 🔑 | from step 2.8 |

   Leave the others as they are; the WhatsApp ones can stay empty for now. Make
   sure every 🔑 row has **Encrypt** ticked. **Save**.
7. Go back to **Settings**, click the **migrate** component → **Environment Variables** → **Edit**.
   Set `LINCK_MIGRATION_DATABASE_URL` 🔑 to the second line from step 4.2. **Encrypt**, **Save**.
8. Saving starts a new deploy. Watch it in the **Activity** tab. First the
   **migrate** job prepares the database, then the API starts. It should go green.
   If it fails, open its logs: the API says exactly which setting is wrong.
9. On the app's overview, copy its address, such as `https://linck-api-abcde.ondigitalocean.app`.
   Its host part (`linck-api-abcde.ondigitalocean.app`) is the **API host**.

> **Never run `doctl apps create` or `update` with `.do/app.yaml` again on this app.**
> The file has empty passwords, and they would replace the real ones. To change a
> setting, use the control panel, as above.

## 8. Lock the database door

1. **Databases** → **linck-db** → **Settings** → **Trusted sources** → **Edit**.
2. Make sure **linck-api** (the app) is in the list. If it is not, type its name and add it.
3. Remove your own IP address, unless you will run step 4 again soon. **Save**.

## 9. Point Vercel at the API

1. In Vercel, open the Linck project → **Settings** → **Environment Variables**.
   Add `VITE_API_URL` with the value `/api`, for **Production**. **Save**.
2. In the repository, edit `vercel.json`. In `"rewrites"`, add the API rule **first**,
   before the line that sends everything else to `index.html`:
   ```json
   "rewrites": [
     { "source": "/api/:path*", "destination": "https://<api host>/:path*" },
     { "source": "/(.*)", "destination": "/index.html" }
   ],
   ```
   Replace `<api host>` with the API host from step 7.9: no `https://`, no slash at the end.
   The order matters: the second rule matches everything, so the API rule must come before it.
3. Commit and push to `main`. Vercel deploys the web app with it.

## 10. Check it works

1. Open `https://<api host>/health`. It should say `{"status":"ok","environment":"production"}`.
2. Open `https://<vercel domain>/api/health`. The same answer means Vercel passes requests on.
3. Open `https://<vercel domain>/api/auth/google/login`. Google asks you to pick an
   account, then sends you back to Linck.

Signing in works only for people already registered in Linck, and there is no screen
to register the first people yet. Until your organization and your own user are added
to the database, step 3 ends with "This account is not registered for Linck". That
message still proves Google sign-in is wired up. Ask your developer to add them.

The bucket is first used when a photo is saved through the API: a WhatsApp slip, or a
bill once the expense screens save to the API (today they keep bills in the browser).
If the Spaces key is wrong, that first save fails and the API's logs say why.

## 11. WhatsApp slips (later)

When the WhatsApp Business number is ready, set these on the **api** component:
`LINCK_WHATSAPP_VERIFY_TOKEN` 🔑 (any long random text), `LINCK_WHATSAPP_APP_SECRET` 🔑,
`LINCK_WHATSAPP_ACCESS_TOKEN` 🔑, `LINCK_WHATSAPP_PHONE_NUMBER_ID`, and
`LINCK_WHATSAPP_ORGANIZATION_ID` (your organization's id in Linck). In Meta's app
dashboard, set the webhook URL to `https://<vercel domain>/api/webhooks/whatsapp`,
with the same verify token, and subscribe to **messages**.

## 12. Industry news summaries (optional, free)

1. Open https://aistudio.google.com/apikey, sign in with a Google account, and create an API key.
2. On the **api** component, set `LINCK_AI_API_KEY` 🔑 to that key and save. The app redeploys.
3. In Linck, open **Industry news** and press **Refresh**.

Until the key is set, Industry news shows headlines only, and no AI model is called. Gemini's
free tier is the default (`LINCK_AI_MODEL=gemini-2.5-flash`). To use another free provider
(OpenRouter, Groq, or Ollama on your own server), see `apps/api/.env.example`.

---

## Every day

**Deploys.** Every push to `main` deploys the API. The **migrate** job runs first; if
it fails, the deploy stops and the old version keeps running.

**Roll back.** **App Platform** → **linck-api** → **Activity**. Find the last good
deploy, open its **...** menu, choose **Rollback**. Then revert the bad commit on
`main`, or the next push brings it back. A rollback does not undo database changes.
If a deploy damaged data, restore the database first (below), then roll back.

**Backups.** DigitalOcean backs the database up every day by itself and keeps the
last 7 days (the cluster's **Backups** tab shows what is kept). You can restore to any
moment in that window.

**Restore.** **Databases** → **linck-db** → **Backups** → **Restore from backup**, and
pick the date and time. This makes a **new** cluster beside the old one; the roles
and passwords come with it. Then:

1. Add **linck-api** to the new cluster's trusted sources.
2. In both database URLs (the **api** and **migrate** components), replace the old
   host with the new one. **Save**; this redeploys.
3. In the app's **Settings** → **App Spec**, change `cluster_name: linck-db` to the
   new cluster's name. **Save**.
4. Once all is well, delete the old cluster.

Files in Spaces are never changed or deleted by the API, so a database restore
needs nothing from the bucket. For a second copy of the files, copy the bucket to
another region now and then (for example with `rclone`).

## What it costs each month

Check current pricing at <https://www.digitalocean.com/pricing> before you start.
The monthly bill is roughly:

- **App Platform:** one instance of the smallest size for the API, plus the minutes
  the migrate job runs on each deploy.
- **Managed PostgreSQL:** the smallest single-node plan. A standby node costs extra.
- **Spaces:** a flat monthly subscription that includes some storage and transfer;
  more is charged by the gigabyte.
- **Bandwidth** beyond what each of these includes.
- Vercel is billed by Vercel, as today.

## Keeping it safe

**Each part has only the power it needs.**

- The API connects as `linck_app`. It owns nothing and cannot skip the rule that
  keeps each company's rows apart (no BYPASSRLS). The API refuses to start if it ever could.
- Only the **migrate** job holds `linck_migrator`, the role that changes the database. The API never does.
- `doadmin` is used only on your computer, only for step 4. It is not in App Platform.
- `linck_identity` and `linck_audit` cannot sign in at all; they only own two
  database functions.
- The Spaces key reaches one bucket. The bucket is private; files go out only
  through the API, after it checks who is asking.
- The database lets in only the app (and your IP while you need it).
- The API refuses to start with a short or default session secret, or without the bucket.

**Change the secrets** when someone who knew them leaves, or if one may have leaked:

- **Session secret:** make a new one (step 5) and save it. Everyone has to sign in again.
- **Database passwords:** set new `LINCK_MIGRATOR_PASSWORD` and `LINCK_APP_PASSWORD`,
  run step 4 again (add your IP to trusted sources first), then paste the two new URLs
  (step 7.6 and 7.7) right away. The old passwords stop working as soon as step 4 runs.
- **Spaces key:** create a new key (step 2.7), paste it, wait for the deploy, then delete the old key.
- **Google client secret:** in the Google console, add a new secret to the client,
  paste it, wait for the deploy, then delete the old one.
- **doadmin:** **Databases** → **linck-db** → **Users & Databases** → `doadmin` → **Reset password**.

**Good to know.** At its busiest the API holds up to 30 database connections per
instance, which can be more than the smallest database plan allows (the cluster's
overview shows the limit). Day to day it uses a few. If the logs ever say "too many
connections", move the cluster up a plan, and check this before adding instances.
