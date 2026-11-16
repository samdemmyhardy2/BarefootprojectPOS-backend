# Cloudbeds historical backfill: the 20 duplicates

Run `110a6d8e-1e73-42fe-9c8e-f4cd3ef501c7` (BACKFILL, 4 November 2026). Nothing was deleted or reprocessed for this investigation. The backfill was not run again.

The figure **20** is the backfill counter for notices whose Message-ID was already known. Those 20 copies were not inserted as new `InboundEmail` rows. Replaying the same check on the 40 saved mailbox messages, in UID order, reproduces the run exactly: 270 nested notices, 248 from `admin@cloudbeds.com`, 20 already-known Message-IDs, 228 queued.

Two other rows on this run have outcome `DUPLICATE`. They are not part of the 20. They were stored and then ignored because they were older than the reservation already on file: Michael Whalley confirmation `<6a9758683ed38@cloudbeds.com>`, and the Nittaya Kook modification `<6ad4446d5f294@cloudbeds.com>`.

## Totals

| Category | Count |
|---|---|
| Genuine duplicate copies of an email whose reservation was already applied | 16 |
| Previously imported before this backfill | 15 |
| Imported earlier in this same run, then seen again | 1 |
| Repeated forwarded copies | 8 |
| Duplicate HTML or MIME representations with a different identity | 0 |
| Same IMAP message downloaded twice | 0 |
| Fingerprint collisions | 0 |
| Incorrectly treated as already done | 4 sightings, 2 distinct events |
| Uncertain | 0 |

The 16 genuine copies and the 4 missed-event sightings add up to 20. The “previously imported” and “repeated forwarded” rows overlap those 20; they describe why the Message-ID was already known.

No two different Cloudbeds reservation IDs were merged. Inside each parent message, no two different Message-IDs were collapsed onto one reservation event.

## How a duplicate was decided

The backfill dedupes with `inboundMessageKey`:

1. If the notice has a Message-ID, that header is the identity (whitespace collapsed, cut at 900 characters).
2. If it has no Message-ID, the identity is `sha256:` plus the SHA-256 of the raw bytes.

All 20 had a Message-ID. None used the raw-byte fingerprint, so this was not a fingerprint collision. Guest name was not used. Confirmation number was not used for this counter.

A second, separate dedupe runs only inside one parent message, before a notice is queued:

- `noticeIdentity` uses Message-ID when present, otherwise a SHA-256 of subject, sender, notice time, and normalized text. It does not use guest name alone.
- `reservationEventKey` is event type, confirmation number, guest name, check-in day, and check-out day. It does not include price or room type. Two different emails with the same confirmation and the same dates could theoretically collapse here. That did not happen in this mailbox: every parent that contained two parsed reservations had different Message-IDs and different event keys.

The known set was filled, before the scan, with the Message-IDs already stored from earlier mailbox syncs. A later copy of the same Message-ID incremented `duplicates` and was not queued.

## The two events that were actually skipped

Message-ID matching was right: each of these is the same email as a row already stored. The mistake is that the stored row had been **skipped**, not imported. The backfill treated “row exists” as “event already applied.”

### Dietmar Koch modification, confirmation `7928979168239`

Cloudbeds reservation `190507508`.

The Gmail forward UID 7, `InboundEmail` `12c48561-6ff6-4613-84e4-843d7cec6cf9`, was skipped on an earlier sync with `Not a Cloudbeds reservation.` The message is a forward: the outer sender is Gmail, and the Cloudbeds notice is inline. Its Message-ID is the Gmail id `<CA+MzmrS8PTV1+g9V=K1tFnb+saTWFoZKZG8FUH2uRYcMCyi9xQ@mail.gmail.com>`, not an `@cloudbeds.com` id. Depth 0, no separate attachment. Records 4 and 14 are that same message (the mailbox copy, then the copy attached inside UID 33).

The confirmation `<6ae78a41e4cc1@cloudbeds.com>` was imported. It is dated 1 November 2026 11:51 UTC. The modification is dated 1 November 2026 19:10 UTC, so it is the newer event. Both have check-in 1 March 2027 and check-out 4 March 2027. They differ where it matters:

| | Confirmation, applied | Modification, not applied |
|---|---|---|
| Room type | Double room with terrace (Standard Rate) | Standard Bungalow |
| Grand total | 6000.00 | 7500.00 |

Stay `b2835773-eed3-4dba-b2ab-84d8c8bf9713` still has the confirmation room type and total. It was not cancelled. No second stay was created. This is one reservation, and the later modification was not applied.

### Julia Bilyaeva cancellation, confirmation `5443734844866`

Cloudbeds reservation `189338481`.

The Gmail forward UID 8, `InboundEmail` `552003ed-91f7-4216-a507-8f717883a700`, was skipped earlier with `Not a Cloudbeds reservation.` Message-ID `<CA+MzmrSnfYq4K7p1qYowtYek8YJTCRjd5HvEKrcMJuihh_wc=w@mail.gmail.com>`. Records 5 and 10 are that same cancellation.

The confirmation `<6ad50acc1016e@cloudbeds.com>` was imported and is dated 18 October 2026 11:07 UTC. The cancellation is dated 29 October 2026 11:51 UTC, so it is newer. Stay `1f4b5f0a-8aa7-4587-852d-4e99d2b4801f` is still active for 11–17 December 2026, Standard Bungalow, total 14200.00. The cancellation was not applied.

## Safe recovery

Do not delete the stays, the skipped rows, or the imported confirmations. Do not run the backfill again first: both Message-IDs are already stored, so another scan will skip them again.

Requeue only these two skipped rows. The current importer reads the embedded Cloudbeds sender, and matching is by Cloudbeds reservation id, so each retry updates the stay that already exists:

1. Retry `12c48561-6ff6-4613-84e4-843d7cec6cf9`. Expect stay `b2835773-eed3-4dba-b2ab-84d8c8bf9713` to change to Standard Bungalow and grand total 7500.00, with the same 1–4 March 2027 dates. No second stay.
2. Retry `552003ed-91f7-4216-a507-8f717883a700`. Expect stay `1f4b5f0a-8aa7-4587-852d-4e99d2b4801f` to be cancelled, because this cancellation is newer than its confirmation, and to leave the calendar. No second stay.

The Email import page can retry a skipped row, or `POST /rooms/email-imports/{id}/retry`. Afterward, check that each Cloudbeds id still belongs to exactly one stay.

## All 20 records

Detection for every row is **Message-ID exact match**. The duplicate Message-ID is the original Message-ID; none of these had a second id. Sender on the parsed notice is `admin@cloudbeds.com`.

### Already imported, then seen again as the same mailbox message

These ten are depth 0. The parent Message-ID is the same as the notice. The earlier sync had already processed them into a stay. Skipping them did not drop a newer modification or cancellation.

| # | UID | Confirmation | Cloudbeds ID | Event | Existing row | Status | Stay |
|---|---|---|---|---|---|---|---|
| 1 | 3 | 8504018395590 | 190332807 | confirmed | 9505c4c6-75ed-4985-951e-43b8eabb1468 | PROCESSED | a8865726-382e-49af-aae1-695ac86e3371 |
| 2 | 4 | 5570523880258 | 190419399 | confirmed | 35a4f99d-ff73-41b8-8e92-004946b96ce4 | PROCESSED | 6f7dacdf-ad93-4a6c-b408-5baa6dba6dca |
| 3 | 5 | 6136244017054 | 190381396 | confirmed | 5f65cf9b-c473-4426-92f9-164f48f80b4c | PROCESSED | 657bb5e4-fd23-4a93-ba31-58a902432b4d |
| 6 | 15 | 2994876833557 | 190563467 | confirmed | c0639b3f-2378-4c8c-9a35-8a57d6ec7410 | PROCESSED | bb0dbe42-2c24-43a1-a0cb-d7752f1896d7 |
| 7 | 20 | 1357541487627 | 190634104 | confirmed | 476d1ad0-3f86-48b8-916e-92468e102738 | PROCESSED | 370e919d-003c-4e57-9a57-92150fdc8de5 |
| 8 | 23 | 3744859086339 | 190688563 | confirmed | 8366b7cc-51d1-4e68-acf6-f31a414d00e6 | PROCESSED | b1f88ebc-a383-4e20-838c-6652f41e7f5f |
| 17 | 35 | 6984472704653 | 190742268 | confirmed | 88902ac8-6db1-488d-8860-401c3fec5b35 | PROCESSED | 06d12320-6ab8-4f25-9fcc-b24406140793 |
| 18 | 36 | 7709172384024 | 190743679 | confirmed | f0bdc998-6a0b-43bb-862e-c245d51244bf | PROCESSED | ef27deb7-2664-4244-8a57-7ef78fa32755 |
| 19 | 38 | 8251686420666 | 190772886 | confirmed | c27b7295-7812-4e31-bd33-dcc5a04b5b3a | PROCESSED | 9c7d28c4-9bc3-4a56-b3b4-936bcdf34f6e |
| 20 | 39 | 2850774638039 | 190774585 | confirmed | 7c0a7f4a-a1b6-4926-b6e8-6683476e830f | PROCESSED | 265dcf5c-02c7-4301-98c6-3711ee7373d3 |

Message-IDs, in that order:

1. `<CA+MzmrT9om3__Va8C3Gu+W=R2Ft9pVV2ee4m1HJ6GLYb9NC=Nw@mail.gmail.com>` — Philipp Bachmann confirmation, email date 31 October 2026 09:32 UTC, notice 30 October 2026 13:44 UTC. Parent subject `Fwd: Reservation CONFIRMED - Philipp Bachmann - Reservation #8504018395590`. No attachment filename. Check-in 21 November 2026, check-out 23 November 2026, Superior Queen, 5200.00. Stay is active.
2. `<CA+MzmrT3LCJNRhcPXQY3j-Vtr8AOxMx3AbTGDJRsa0AdKMYVoA@mail.gmail.com>` — Zuna Mathe confirmation, email date 1 November 2026 09:36 UTC, notice 31 October 2026 17:38 UTC. Parent subject `Fwd: Reservation CONFIRMED - Zuna Mathe - Reservation #5570523880258`. Check-in 8 January 2027, check-out 13 January 2027, Double room with terrace, 10000.00. Stay is active. This stay has no Cloudbeds id stored; the notice’s id is 190419399. The duplicate did not merge it with another reservation.
3. `<CA+MzmrTOC0ApwvjxN7k39MJW4kd+ZWr3hpsVgMM++idqUjE9WA@mail.gmail.com>` — Patricia Neubauer confirmation, email date 1 November 2026 09:37 UTC, notice 31 October 2026 03:16 UTC. Parent subject `Fwd: Reservation CONFIRMED - Patricia Neubauer - Reservation #6136244017054`. Check-in 16 December 2026, check-out 19 December 2026, Deluxe Bungalow with Sea View, 17400.00. Stay is active and also has no Cloudbeds id stored.
4. `<6ae88bbd00e0b@cloudbeds.com>` — Dirk Reichensperger confirmation, 2 November 2026 13:10 UTC. Parent subject is the same confirmation. Check-in 10 January 2027, check-out 15 January 2027, Superior Queen, 15000.00. Stay is active and carries the same Cloudbeds id.
5. `<6ae99637e33b3@cloudbeds.com>` — Mira Schneider confirmation, 3 November 2026 08:07 UTC. Check-in 14 January 2027, check-out 21 January 2027, Villa no7, 39200.00. Stay is active.
6. `<6aea59084acd2@cloudbeds.com>` — Dietmar Koch confirmation `3744859086339`, not the skipped modification. 3 November 2026 21:58 UTC. Check-in 27 February 2027, check-out 1 March 2027, Standard Bungalow, 5000.00. Stay is active. This is a different reservation from `7928979168239`.
7. `<6aeb4745000e2@cloudbeds.com>` — Stella Anastasia confirmation `6984472704653`, 4 November 2026 14:55 UTC. Check-in 13 February 2027, check-out 17 February 2027, Superior Queen, 12000.00.
8. `<6aeb4c4723c37@cloudbeds.com>` — Stella Anastasia confirmation `7709172384024`, 4 November 2026 15:16 UTC. Check-in 10 February 2027, check-out 12 February 2027, Villa no7, 11200.00. Different Cloudbeds id from the other Stella reservation.
9. `<6aeba95a508e5@cloudbeds.com>` — Dominik El Masry confirmation, 4 November 2026 21:53 UTC. Check-in 18 January 2027, check-out 22 January 2027, villa no 11, 23200.00.
10. `<6aebaf1dee035@cloudbeds.com>` — Stella Anastasia confirmation `2850774638039`, 4 November 2026 22:18 UTC. Check-in 15 February 2027, check-out 19 February 2027, villa no 11, 23200.00.

### Same message forwarded again

Parent for records 10–16 is UID 33, Message-ID `<CA+MzmrRFRM_6ko3OrCMQF-ga6X=f9BAihKS=0TfWj09Y_Kh6RQ@mail.gmail.com>`, stored subject `Reservation CONFIRMED - Dirk Reichensperger - Reservation #2994876833557`. Depth 1. Record 9 is the same kind of repeat from a different parent.

| # | Confirmation | Event | Filename | Existing row | Prior result |
|---|---|---|---|---|---|
| 9 | 6963738589644 | confirmed | Reservation CONFIRMED - Alexander Seidel - Reservation #6963738589644.eml | 8a991bf3-c711-49ae-abd0-db257ac38913 | IMPORTED during this run from UID 12 |
| 10 | 5443734844866 | cancelled | Reservation Canceled - Julia Bilyaeva - Reservation #5443734844866.eml | 552003ed-91f7-4216-a507-8f717883a700 | SKIPPED, not applied |
| 11 | 8504018395590 | confirmed | Reservation CONFIRMED - Philipp Bachmann - Reservation #8504018395590.eml | 9505c4c6-75ed-4985-951e-43b8eabb1468 | PROCESSED |
| 12 | 6136244017054 | confirmed | Reservation CONFIRMED - Patricia Neubauer - Reservation #6136244017054.eml | 5f65cf9b-c473-4426-92f9-164f48f80b4c | PROCESSED |
| 13 | 5570523880258 | confirmed | Reservation CONFIRMED - Zuna Mathe - Reservation #5570523880258.eml | 35a4f99d-ff73-41b8-8e92-004946b96ce4 | PROCESSED |
| 14 | 7928979168239 | modified | Booking.com Modified Reservation - Dietmar Koch - #7928979168239.eml | 12c48561-6ff6-4613-84e4-843d7cec6cf9 | SKIPPED, not applied |
| 15 | 2994876833557 | confirmed | Reservation CONFIRMED - Dirk Reichensperger - Reservation #2994876833557.eml | c0639b3f-2378-4c8c-9a35-8a57d6ec7410 | PROCESSED |
| 16 | 1357541487627 | confirmed | Reservation CONFIRMED - Mira Schneider - Reservation #1357541487627.eml | 476d1ad0-3f86-48b8-916e-92468e102738 | PROCESSED |

Record 9’s Message-ID is `<6a315d12186e0@cloudbeds.com>`. Parent UID 30, Message-ID `<CA+MzmrSxMpk5pPFC+CMO9LY36K684j2exPs81dB-Nh7egfjDOA@mail.gmail.com>`, subject `Reservation CONFIRMED - Tiphaine Robert - Reservation #9312270268680`. Email date 16 June 2026 14:26 UTC. The first copy was queued from UID 12 and imported onto stay `a60a6d97-742a-403d-be7f-08fb61b4c934`. The UID 30 copy is the same confirmation, same Cloudbeds id `178164718`, same 7–15 February 2027 dates. Not a second reservation.

Records 10 and 14 are the second sightings of the skipped Julia cancellation and Dietmar modification. Same Message-ID, same dates, same totals as records 5 and 4. They are not different events.

## Conclusion

Sixteen of the 20 are the same Cloudbeds email seen twice: either the mailbox message was already imported, or the same `.eml` was attached to another forward. Those skips did not drop a modification or cancellation, and they did not merge different reservation IDs.

Four sightings are two Gmail forwards that an earlier sync stored and skipped. Deduping them again left one newer modification and one newer cancellation unapplied. Retry the two skipped rows above; do not rerun the whole backfill and do not delete the existing stays.
