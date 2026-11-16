# Syncing the restaurant laptop to the hosted server

The restaurant runs on the laptop. The hosted server runs this same backend with its own PostgreSQL database, so administrators can look at the data from anywhere. Data only moves one way: laptop → server. The server is a view-only copy.

## How it works

- **Every change is recorded.** The `server_sync` migration adds a `sync_capture` trigger to every table. Each insert, update, or delete writes the row into `SyncChange`, in the same transaction as the change itself. Tables added by later migrations get the trigger when the backend starts.
- **Changes wait while offline.** Every 5 seconds the laptop checks for waiting changes. If there are any, it pings the server; when the server answers, the changes are sent in the order they happened and removed from `SyncChange`. While the server cannot be reached they stay in the laptop's database, also across restarts, and are sent when it answers again.
- **The first sync is a full copy.** The first time (and whenever an admin asks for it with `POST /api/sync/full`), the laptop sends a snapshot of every table. The server deletes all of its application data and loads the snapshot in one transaction, so it matches the laptop exactly. Rows that existed only on the server are removed.
- **Versions must match.** Both databases must have the same migrations applied. If they differ, nothing is sent and the Sync card says which migration each side is at.
- **The server is view-only.** With `SYNC_ROLE=server`, the backend rejects every create, edit, and delete request except sign-in, and it does not import reservation emails.

Uploaded files under `uploads/` (menu photos, logos, avatars) are not copied. Only database rows are.

## Laptop setup

Add to the laptop backend `.env`, then restart:

```
SYNC_SERVER_URL=https://your-server.example.com/api
SYNC_TOKEN=<long random secret, the same on both sides>
```

`SYNC_SERVER_URL` is the server's API base, the same address the app uses ending in `/api`.

## Server setup

On the server, deploy this backend and frontend, run `npx prisma migrate deploy`, and add to its `.env`:

```
SYNC_ROLE=server
SYNC_TOKEN=<the same secret>
```

Make sure the server's reverse proxy allows request bodies of at least 50 MB on `/api/sync/receive/`, for the first full copy (for nginx: `client_max_body_size 50m;`).

## In the app

Administrators see a **Server sync** card in the sidebar on the laptop: synced, changes waiting, offline, or a problem (hover for the details). Its button syncs now. On the server the card says it is a view-only copy.

## Endpoints

- Laptop, admin sign-in: `GET /api/sync/status`, `POST /api/sync/run` (sync now), `POST /api/sync/full` (send a full copy).
- Server, `Authorization: Bearer <SYNC_TOKEN>`: `GET /api/sync/receive/ping`, `POST /api/sync/receive/changes`, `POST /api/sync/receive/full`.
