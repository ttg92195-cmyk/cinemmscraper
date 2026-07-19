#!/bin/sh
# ============================================================================
# Auto-backup script for cinemmscraper SQLite database
# ============================================================================
#
# WHAT THIS DOES
# -------------
# 1. Copies the current SQLite database to a timestamped backup file
# 2. Commits the backup to a separate GitHub repository (private)
# 3. Cleans up backups older than 7 days
# 4. Logs all activity to backup.log
#
# SETUP (ONE-TIME)
# ----------------
# 1. Create a new PRIVATE GitHub repo for backups:
#    https://github.com/new
#    Name: cinemmscraper-backup
#    Private: YES (important — DB contains user-submitted URLs)
#
# 2. Set these environment variables on Railway:
#    BACKUP_GITHUB_TOKEN = ghp_xxxxxxxxxxxx  (Personal Access Token with repo scope)
#    BACKUP_GITHUB_REPO  = ttg92195-cmyk/cinemmscraper-backup
#    BACKUP_GIT_EMAIL    = bro@cinemmscraper.local
#    BACKUP_GIT_NAME     = cinemmscraper-backup-bot
#
# 3. Railway will run this script automatically via cron (see railway.toml).
#
# WHY A SEPARATE REPO?
# --------------------
# - The main repo (cinemmscraper) is PUBLIC — putting DB there would leak data
# - A private backup repo keeps the DB safe but separate from source code
# - If the main repo ever gets hacked, backups are still safe
#
# CRON SCHEDULE
# -------------
# Runs daily at 4:00 AM UTC (configurable in railway.toml).
# ============================================================================
set -e

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

TIMESTAMP=$(date -u +%Y%m%d-%H%M%S)
TODAY=$(date -u +%Y-%m-%d)
LOG_FILE=/tmp/backup.log

# Database paths — Railway uses /app/db/custom.db, local dev uses ./db/custom.db
PROD_DB=/app/db/custom.db
LOCAL_DB=./db/custom.db
DB_PATH=""

if [ -f "$PROD_DB" ]; then
  DB_PATH="$PROD_DB"
elif [ -f "$LOCAL_DB" ]; then
  DB_PATH="$LOCAL_DB"
else
  echo "[$TIMESTAMP] ERROR: No SQLite database found at $PROD_DB or $LOCAL_DB" >> "$LOG_FILE"
  exit 1
fi

# Check required env vars
if [ -z "$BACKUP_GITHUB_TOKEN" ]; then
  echo "[$TIMESTAMP] ERROR: BACKUP_GITHUB_TOKEN env var not set" >> "$LOG_FILE"
  exit 1
fi
if [ -z "$BACKUP_GITHUB_REPO" ]; then
  echo "[$TIMESTAMP] ERROR: BACKUP_GITHUB_REPO env var not set" >> "$LOG_FILE"
  exit 1
fi

GIT_EMAIL="${BACKUP_GIT_EMAIL:-bot@cinemmscraper.local}"
GIT_NAME="${BACKUP_GIT_NAME:-cinemmscraper-backup-bot}"
REPO_URL="https://x-access-token:${BACKUP_GITHUB_TOKEN}@github.com/${BACKUP_GITHUB_REPO}.git"

# Working directory for the backup repo clone
WORK_DIR=/tmp/cinemmscraper-backup-repo

echo "[$TIMESTAMP] ============================================" >> "$LOG_FILE"
echo "[$TIMESTAMP] Starting backup of $DB_PATH" >> "$LOG_FILE"
echo "[$TIMESTAMP] Target repo: $BACKUP_GITHUB_REPO" >> "$LOG_FILE"

# ---------------------------------------------------------------------------
# Step 1: Clone (or pull) the backup repo
# ---------------------------------------------------------------------------

if [ -d "$WORK_DIR/.git" ]; then
  echo "[$TIMESTAMP] Updating existing clone..." >> "$LOG_FILE"
  cd "$WORK_DIR"
  git pull --rebase --quiet || {
    echo "[$TIMESTAMP] WARN: pull failed, re-cloning" >> "$LOG_FILE"
    rm -rf "$WORK_DIR"
    git clone --quiet "$REPO_URL" "$WORK_DIR"
    cd "$WORK_DIR"
  }
else
  echo "[$TIMESTAMP] Cloning backup repo..." >> "$LOG_FILE"
  rm -rf "$WORK_DIR"
  git clone --quiet "$REPO_URL" "$WORK_DIR" 2>> "$LOG_FILE"
  cd "$WORK_DIR"
fi

# Configure git identity (in case it's not set globally)
git config user.email "$GIT_EMAIL" 2>> "$LOG_FILE" || true
git config user.name "$GIT_NAME" 2>> "$LOG_FILE" || true

# ---------------------------------------------------------------------------
# Step 2: Copy current DB to backup with timestamp
# ---------------------------------------------------------------------------

# Make sure backups/ dir exists
mkdir -p backups

# Copy today's backup (overwrite if exists, so we get latest state for the day)
DAILY_BACKUP="backups/db-${TODAY}.sqlite"
echo "[$TIMESTAMP] Copying DB to $DAILY_BACKUP" >> "$LOG_FILE"
cp "$DB_PATH" "$DAILY_BACKUP"

# Also save a timestamped version (for history)
TIMESTAMPED_BACKUP="backups/db-${TIMESTAMP}.sqlite"
cp "$DB_PATH" "$TIMESTAMPED_BACKUP"

# Get DB size for logging
DB_SIZE=$(du -h "$DB_PATH" | cut -f1)
echo "[$TIMESTAMP] DB size: $DB_SIZE" >> "$LOG_FILE"

# ---------------------------------------------------------------------------
# Step 3: Get DB stats (row counts) for the commit message
# ---------------------------------------------------------------------------

DB_STATS=""
if command -v sqlite3 >/dev/null 2>&1; then
  DB_STATS=$(sqlite3 "$DB_PATH" "
    SELECT 'CinemmCache: ' || COUNT(*) FROM CinemmCache
    UNION ALL
    SELECT 'ManualStreamUrl: ' || COUNT(*) FROM ManualStreamUrl
    UNION ALL
    SELECT 'User: ' || COUNT(*) FROM User
    UNION ALL
    SELECT 'Post: ' || COUNT(*) FROM Post;
  " 2>/dev/null | tr '\n' ' ')
  echo "[$TIMESTAMP] DB stats: $DB_STATS" >> "$LOG_FILE"
else
  DB_STATS="sqlite3 not available"
fi

# ---------------------------------------------------------------------------
# Step 4: Clean up old timestamped backups (keep last 7 days)
# ---------------------------------------------------------------------------

echo "[$TIMESTAMP] Cleaning up old timestamped backups (>7 days)..." >> "$LOG_FILE"
find backups/ -name "db-*.sqlite" -type f -mtime +7 -delete 2>> "$LOG_FILE" || true

# Also keep only the latest daily backup per day (already overwritten above)
# But remove old daily backups too
find backups/ -name "db-20*.sqlite" -type f -not -name "db-$(date -u +%Y-%m-%d).sqlite" -mtime +30 -delete 2>> "$LOG_FILE" || true

# ---------------------------------------------------------------------------
# Step 5: Commit + push to GitHub
# ---------------------------------------------------------------------------

git add backups/ 2>> "$LOG_FILE"

# Check if there are any changes to commit
if git diff --cached --quiet; then
  echo "[$TIMESTAMP] No changes to commit (DB unchanged since last backup)" >> "$LOG_FILE"
else
  COMMIT_MSG="chore(backup): ${TODAY} ${TIMESTAMP}

DB stats: ${DB_STATS}
DB size: ${DB_SIZE}
Source: ${DB_PATH}"

  git commit -m "$COMMIT_MSG" --quiet 2>> "$LOG_FILE"
  echo "[$TIMESTAMP] Committed. Pushing to GitHub..." >> "$LOG_FILE"

  if git push --quiet 2>> "$LOG_FILE"; then
    echo "[$TIMESTAMP] ✅ Backup pushed successfully" >> "$LOG_FILE"
  else
    echo "[$TIMESTAMP] ❌ Push failed — will retry next run" >> "$LOG_FILE"
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Step 6: Update latest.json (metadata file for easy restore)
# ---------------------------------------------------------------------------

LATEST_JSON="latest.json"
cat > "$LATEST_JSON" <<EOF
{
  "lastBackup": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "backupFile": "$DAILY_BACKUP",
  "dbSize": "$DB_SIZE",
  "dbStats": "$DB_STATS",
  "sourceDb": "$DB_PATH",
  "restoreInstructions": "Download $DAILY_BACKUP, replace your db/custom.db, run prisma db push"
}
EOF

git add "$LATEST_JSON" 2>> "$LOG_FILE"
git commit -m "chore(backup): update latest.json metadata" --quiet 2>> "$LOG_FILE" || true
git push --quiet 2>> "$LOG_FILE" || true

echo "[$TIMESTAMP] ✅ Backup complete" >> "$LOG_FILE"
echo "[$TIMESTAMP] ============================================" >> "$LOG_FILE"
echo "" >> "$LOG_FILE"

# Print last 50 lines of log for visibility
tail -50 "$LOG_FILE"
