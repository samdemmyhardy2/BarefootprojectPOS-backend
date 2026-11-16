# Google Drive backup of orders

The server keeps one Excel workbook in a Google Drive folder, `orders-from-2026-11-02.xlsx`. Every backup rebuilds it from the database and replaces the file in place, so Drive always holds one up-to-date copy.

- **Summary** sheet — one row per day: orders, Total, Cash, QR, Room tab, Card, Commission, Unpaid, and cancelled orders, with an "All days" row.
- **One sheet per day** (named `YYYY-MM-DD`) — that day's orders, then its totals: Total, Cash, QR, Room tab, Card, Commission, Unpaid, and Cancelled.

A day runs from 00:00:00 to 23:59:59, Asia/Bangkok. The first day is `BACKUP_START_DATE` (default `2026-11-02`); the last is today. Cancelled orders are listed but not counted in Total. Commission is counted on the day it was paid and is not part of Total.

The backup runs every day at `BACKUP_HOUR` (Asia/Bangkok, default 22:00). An administrator can run it at any time with the **Back up to Drive** button on the Order history page. If the server was off at the backup hour, it runs on the next start when the Drive file is older than the missed backup.

## One-time setup

1. In Google Cloud Console, create a project, enable the **Google Drive API**, and create an OAuth client of type **Desktop app**.
2. On the OAuth consent screen, set the publishing status to **In production**. In **Testing**, Google expires the refresh token after seven days and the backup stops.
3. Run the helper on a computer with a browser and sign in with the Google account that should hold the backups:

   ```bash
   GOOGLE_DRIVE_CLIENT_ID=... GOOGLE_DRIVE_CLIENT_SECRET=... node scripts/google-drive-auth.mjs
   ```

4. Put the values in the backend `.env` and restart the server:

   ```
   GOOGLE_DRIVE_CLIENT_ID=
   GOOGLE_DRIVE_CLIENT_SECRET=
   GOOGLE_DRIVE_REFRESH_TOKEN=
   # Optional
   GOOGLE_DRIVE_BACKUP_FOLDER=Restaurant table order backups
   BACKUP_HOUR=22
   BACKUP_START_DATE=2026-11-02
   ```

The server asks only for the `drive.file` scope: it can see the folder and files it created, nothing else in the account. For that reason it creates its own folder by name; it cannot write into a folder made by hand in Drive. Keep the folder and file names unchanged, or new ones are created. Changing `BACKUP_START_DATE` starts a new file with the new date in its name.

## Admin endpoints

- `GET /api/backups/status` — whether backup is configured, the file name, the next run time, and the last result.
- `POST /api/backups/run` — rebuild and upload now (the Order history button calls this).
