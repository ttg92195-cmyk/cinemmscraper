# Database Auto-Backup System

## 🎯 Why This Exists

Railway's free trial lasts 30 days. After that, the database (SQLite file)
will be lost unless we back it up somewhere safe. This script runs daily
to commit the database to a **separate private GitHub repository** so
it can be restored on any new host.

## 📦 What Gets Backed Up

- **`/app/db/custom.db`** — the entire SQLite database
- Contains:
  - `CinemmCache` table (search results cache, 24h TTL)
  - `ManualStreamUrl` table (permanently-stored stream URLs — THE IMPORTANT DATA)
  - `User` / `Post` tables (legacy, mostly empty)

## 🔧 Setup (One-Time, ~10 minutes)

### Step 1: Create a PRIVATE backup repository on GitHub

1. Go to https://github.com/new
2. **Repository name**: `cinemmscraper-backup`
3. **Visibility**: ⚠️ **PRIVATE** (very important — DB contains URLs)
4. **DO NOT** initialize with README/license (keep it empty)
5. Click "Create repository"

### Step 2: Create a Personal Access Token for backups

1. Go to https://github.com/settings/tokens
2. Click "Generate new token (classic)"
3. **Note**: `cinemmscraper-backup-bot`
4. **Expiration**: 90 days (or "No expiration" if you prefer)
5. **Scopes**: ✅ `repo` (Full control of private repositories)
6. Click "Generate token"
7. **Copy the token** (starts with `ghp_`) — you'll only see it once

### Step 3: Set environment variables on Railway

1. Go to your Railway project: https://railway.app
2. Open your `cinemmscraper` service
3. Go to **Variables** tab
4. Add these variables:

   | Variable Name | Value |
   |---|---|
   | `BACKUP_GITHUB_TOKEN` | `ghp_your_token_here` |
   | `BACKUP_GITHUB_REPO` | `ttg92195-cmyk/cinemmscraper-backup` |
   | `BACKUP_GIT_EMAIL` | `bot@cinemmscraper.local` (optional) |
   | `BACKUP_GIT_NAME` | `cinemmscraper-backup-bot` (optional) |

5. Railway will auto-redeploy with the new variables.

### Step 4: Set up a Railway Cron Job (triggers daily backup)

1. In your Railway project, click **"+" (New Service)** → **"Cron Job"**
2. **Name**: `daily-backup`
3. **Schedule**: `0 4 * * *` (4:00 AM UTC daily — pick a low-traffic time)
4. **Repository**: select `ttg92195-cmyk/cinemmscraper`
5. **Start command**:
   ```
   sh -c "cd /app && ./scripts/backup-db.sh"
   ```
6. **Variables**: copy the same `BACKUP_*` variables from the main service
7. Click **Deploy**

✅ Done! The backup will run daily at 4 AM UTC.

## 🧪 Manual Test (verify it works)

You can trigger a manual backup anytime to verify the setup works:

1. Go to Railway → your `daily-backup` cron service
2. Click **"Trigger"** (manual run button)
3. Check the **Deploy Logs** — you should see:
   ```
   [2026-07-19-04:00:01] Starting backup of /app/db/custom.db
   [2026-07-19-04:00:01] Cloning backup repo...
   [2026-07-19-04:00:03] Copying DB to backups/db-2026-07-19.sqlite
   [2026-07-19-04:00:03] DB size: 1.8M
   [2026-07-19-04:00:04] DB stats: CinemmCache: 13 ManualStreamUrl: 45 ...
   [2026-07-19-04:00:05] Committed. Pushing to GitHub...
   [2026-07-19-04:00:08] ✅ Backup pushed successfully
   ```

4. Verify on GitHub: visit `https://github.com/ttg92195-cmyk/cinemmscraper-backup`
   - You should see a `backups/` folder
   - Inside: `db-YYYY-MM-DD.sqlite` files
   - `latest.json` with metadata

## 🔄 Restore (when migrating to a new host)

When Railway trial expires and you need to move to a new host:

1. **Download the latest backup** from GitHub:
   - Go to `https://github.com/ttg92195-cmyk/cinemmscraper-backup`
   - Download `backups/db-YYYY-MM-DD.sqlite` (latest date)
   - Or download `latest.json` to find the latest backup file

2. **Set up the new host** (Fly.io, Render, another Railway account, etc.)

3. **Restore the database** on the new host:
   - Replace the new host's `db/custom.db` with your downloaded file
   - Or upload via the new host's file system / volume

4. **Test the website** — verify all stream URLs are still there

## 📋 Backup Strategy

| File | Kept for | Purpose |
|---|---|---|
| `db-YYYY-MM-DD.sqlite` (daily) | 30 days | One per day, latest state |
| `db-YYYYMMDD-HHMMSS.sqlite` (timestamped) | 7 days | Multiple per day, history |
| `latest.json` | Forever | Metadata (latest backup pointer) |

Total disk usage in backup repo: ~50-200MB (depending on data growth).

## ⚠️ Important Notes

- **Backup repo MUST be private** — public would leak user-submitted URLs
- **GitHub token expiration**: check the token expiration date, regenerate
  before it expires (or backups will silently fail)
- **Token permissions**: only needs `repo` scope — nothing else
- **If backup fails**: Railway cron will retry on next scheduled run; check
  logs to see what went wrong

## 🚨 Troubleshooting

### "fatal: Authentication failed"

- Token expired or wrong → regenerate token, update `BACKUP_GITHUB_TOKEN`
- Repo name wrong → check `BACKUP_GITHUB_REPO` matches exactly

### "fatal: not a git repository"

- Working directory issue → script auto-recovers by re-cloning

### "No SQLite database found"

- DB file moved → check `PROD_DB` path in script (should be `/app/db/custom.db`)

### Push fails repeatedly

- Check if backup repo has any manual commits that conflict → use `git push --force`
  (the script auto-recovers via re-clone on next run)

## 📞 Quick Reference

```bash
# Manual test on local machine (set env vars first):
BACKUP_GITHUB_TOKEN=ghp_xxx BACKUP_GITHUB_REPO=user/repo ./scripts/backup-db.sh

# Verify backup on GitHub:
# https://github.com/ttg92195-cmyk/cinemmscraper-backup

# Trigger manual backup on Railway:
# Railway dashboard → daily-backup service → "Trigger" button
```
