# Cloudbeds reservation email

Table & Thyme reads forwarded Cloudbeds mail from the existing mailbox. It does not install or change Postfix or Dovecot, and the browser never opens IMAP.

Set `IMAP_PASSWORD` to the existing mailbox password. The other mailbox settings are `IMAP_HOST`, `IMAP_PORT`, `IMAP_SECURE`, `IMAP_USER`, and `IMAP_MAILBOX`. The API does not return that password.

## What is parsed

The importer stores the original MIME message, then reads the Cloudbeds HTML inside forwarded Gmail markup. Labels come from the reservation table that contains "Reservation Summary", not from the forwarding headers.

Gmail sometimes forwards the Cloudbeds message as an attached `.eml` (`message/rfc822`) and leaves the outer subject empty. That attachment is opened as its own message, including a nested multipart/alternative body, and the same parser reads it. The outer Gmail date stays on the import as the received time. The Cloudbeds date, subject, and sender come from the attached message. A forward that contains several different Cloudbeds messages queues each one. The outer wrapper is not a second reservation, and the same Message-ID is stored once. A payment receipt is recorded and does not open a stay.

A confirmed notice is passed to the existing stay import. The guest is the stay’s primary guest. The confirmation number and source identify the booking, so the same email does not create a second stay or another guest. A room the staff already assigned is left as it is.

Room type names are matched to the room numbers already on the calendar. A type with one room, such as Superior Queen, is assigned to that room when it is free for the whole stay. Standard Bungalow and Double room with terrace stay unassigned with `UNASSIGNED_MANUAL_SELECTION_REQUIRED`. Unknown types, missing rooms, and overlapping stays also stay unassigned. Assigned bookings show on their room. Unassigned bookings show on the Unassigned row.

Money is stored in decimal columns: average nightly rate, grand total, deposit, amount paid, and balance due. Each nightly rate is stored on its own row. Dates in this mail use `DD/MM/YYYY`. Amounts may be written as `THB 2,500.00` or `฿2,500.00`. Deposit amount and amount paid stay separate.

## Modifications and cancellations

The original Cloudbeds subject and body decide the notice kind. The outer Gmail subject is only a fallback.

- `CONFIRMED` creates the reservation, or is ignored when that confirmation and source already exist.
- `MODIFIED` updates the existing reservation. Guest, dates, room type, counts, nightly rates, and quoted totals change. Amount paid is updated only when the email has its own Amount Paid line. Deposit amount is never copied into amount paid. Room payments and folio charges are left as they are.
- `CANCELLED` (including “Canceled”) sets `cancelledAt` and keeps the guest, dates, folio, and payments. It does not refund or delete anything.
- `UNKNOWN`, and a modification or cancellation that matches no reservation, is stored for manual review. It does not create a stay.

Matching uses the Cloudbeds reservation id first, then the confirmation number, then the source reservation id together with the booking source. Guest name is never the match. A confirmation that finds an existing stay updates it when the dates, guest, room type, or price changed. It does not open a second stay. An older confirmation does not reopen a canceled stay. A newer confirmation or modification does, and an older cancellation does not overwrite that later event. Family suite, Standard Bungalow, and Double room with terrace stay unassigned.

`POST /rooms/email-imports/backfill` reads the whole mailbox, including mail that was already read, and ignores the daily UID checkpoint. Events for one reservation are applied in the original Cloudbeds date order. Running it again skips message ids that are already stored and does not delete stays. Daily sync remains `POST /rooms/email-imports/poll`.

The mailbox settings are the existing `IMAP_HOST`, `IMAP_PORT` (993), `IMAP_SECURE`, `IMAP_USER`, and `IMAP_PASSWORD`. `CLOUDBEDS_IMAP_*` is only a fallback name for those same values. `CLOUDBEDS_SENDER` defaults to `admin@cloudbeds.com`. `CLOUDBEDS_SYNC_INTERVAL_HOURS` defaults to 24 and `CLOUDBEDS_SYNC_ENABLED` defaults to on. `POST /rooms/email-imports/poll` runs the same sync immediately. The sync remembers the last mailbox uid and reads unseen mail plus an overlap, not only the last day. One sync runs at a time. The Cloudbeds id comes from the View Reservation URL and is stored separately from the confirmation number and the source reservation id.

An older Cloudbeds notice does not overwrite a newer one. The same message id is stored once, including across restarts. Each imported message keeps its original subject, Cloudbeds sender, notice time, event type, processing status, and raw MIME. A message with no Message-ID is stored under a SHA-256 fingerprint of its raw MIME instead.

## A full mailbox at once

There is no separate queue service and no Redis. Each fetched message is inserted as `PENDING` on `InboundEmail`, then a worker in the same mail service claims a few rows at a time with `FOR UPDATE SKIP LOCKED`. `MAIL_CONCURRENCY` controls that width (default 3, maximum 5). `MAIL_LOOKBACK` is how many recent mailbox UIDs are read in addition to every unseen message (default 200, at least 90). One message that cannot be read does not stop the others.

`PROCESSED` is the completed success state. `DUPLICATE` means the same message or the same confirmation was already imported. `SKIPPED` is a permanent non-reservation or a review that is not retried automatically. `FAILED` is a temporary error that used its attempts. `MAIL_MAX_ATTEMPTS` (default 5) and `MAIL_RETRY_BASE_MS` (default 2000) bound the backoff. A message is not marked seen until it reaches one of those terminal states. On startup, rows left in `PROCESSING` return to `PENDING`. An admin can queue a failed or skipped row again with `POST /rooms/email-imports/:id/retry`.

A confirmation is locked for the length of its import transaction, so two workers cannot both create it. A repeated confirmation does not create another stay. A modification updates the stay, and a cancellation sets `cancelledAt` without deleting the guest, folio, or payments. A modification that arrives before its confirmation is retried until the confirmation is stored, or left for review when the attempts run out.

The checked fixtures are `email-3.eml`, `email-4.eml`, and `email-5.eml` for confirmations, `email-7.eml` for a Booking.com modification, `email-8.eml` for a cancellation, and `email-12.eml` for a confirmation attached as `message/rfc822`. `src/modules/rooms/fixtures/cloudbeds-confirmed.html` remains the HTML sample.
