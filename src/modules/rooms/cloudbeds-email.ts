import { createHash } from 'node:crypto';
import { parse, type HTMLElement } from 'node-html-parser';
import { simpleParser } from 'mailparser';

export type CloudbedsNoticeKind = 'confirmed' | 'modified' | 'cancelled' | 'payment' | 'unknown';

export type CloudbedsNightlyRate = { night: Date; amount: string; currency: string };

/** Money is a decimal string such as "2600.00", never a JavaScript number. */
export type CloudbedsEmailReservation = {
  kind: CloudbedsNoticeKind;
  guestName: string;
  guestEmail: string | null;
  source: string;
  confirmationNumber: string;
  sourceReservationId: string | null;
  cloudbedsReservationId: string | null;
  checkIn: Date;
  checkOut: Date;
  nights: number | null;
  roomType: string | null;
  roomNumber: string | null;
  adults: number | null;
  children: number | null;
  currency: string | null;
  averageNightlyRate: string | null;
  nightlyRates: CloudbedsNightlyRate[];
  grandTotal: string | null;
  depositAmount: string | null;
  amountPaid: string | null;
  balanceDue: string | null;
  paymentMethod: string | null;
};

export type ImportedStayMatch = {
  id: string;
  bookingSource: string | null;
  confirmationNumber: string | null;
  sourceReservationId: string | null;
  cloudbedsReservationId: string | null;
};

export type StayNoticePatch = {
  primaryGuestName?: string;
  guestEmail?: string | null;
  guestNotes?: string;
  bookingSource?: string;
  sourceReservationId?: string | null;
  cloudbedsReservationId?: string | null;
  roomType?: string | null;
  adults?: number | null;
  children?: number | null;
  nights?: number | null;
  currency?: string | null;
  averageNightlyRate?: string | null;
  grandTotal?: string | null;
  depositAmount?: string | null;
  amountPaid?: string | null;
  balanceDue?: string | null;
  payment?: {
    currency: string | null;
    averageNightlyRate: string | null;
    grandTotal: string | null;
    depositAmount: string | null;
    amountPaid: string | null;
    balanceDue: string | null;
    paymentMethod?: string | null;
  };
  checkedInAt?: Date;
  expectedCheckoutAt?: Date;
  cancelledAt?: Date | null;
};

export type StayNoticePlan = {
  action: 'create' | 'duplicate' | 'modify' | 'cancel' | 'review' | 'stale';
  detail: string | null;
  patch: StayNoticePatch | null;
  replaceNights: boolean;
};

const LABELS: Record<string, string> = {
  'guest name': 'guestName',
  email: 'guestEmail',
  'confirmation number': 'confirmationNumber',
  source: 'source',
  'source reservation id': 'sourceReservationId',
  'room type': 'roomType',
  'room number': 'roomNumber',
  'average nightly rate': 'averageNightlyRate',
  'grand total': 'grandTotal',
  'deposit amount': 'depositAmount',
  'amount paid': 'amountPaid',
  'balance due': 'balanceDue',
  'payment method': 'paymentMethod',
};

const PLAIN_LABELS = Object.keys(LABELS).sort((left, right) => right.length - left.length);

/** A modification or cancellation updates an existing booking. It is not a second reservation. */
export function reservationImportAction(kind: CloudbedsNoticeKind, exists: boolean) {
  if (kind === 'unknown' || kind === 'payment') return 'review' as const;
  if (kind === 'cancelled') return exists ? 'cancel' as const : 'review' as const;
  if (kind === 'modified') return exists ? 'modify' as const : 'review' as const;
  return exists ? 'duplicate' as const : 'create' as const;
}

export function sameMessageAlreadyStored(existingId: string | null | undefined) {
  return Boolean(existingId);
}

/** A modification or cancellation arrived before its confirmation was stored. Retry it; do not open a second stay. */
export function noticeWaitingForStay(detail: string | null | undefined) {
  return Boolean(detail && /no imported reservation matches confirmation/i.test(detail));
}

/** Subject and body together. "Canceled" and "Cancelled" are the same event. A payment receipt is not a reservation. */
export function cloudbedsNoticeKind(subject: string, body = ''): CloudbedsNoticeKind {
  if (/\bpayment\b/i.test(subject) && /\bconfirm/i.test(subject)) return 'payment';
  const text = `${subject}\n${body}`;
  if (/\bcancell?ed\b/i.test(subject) || /has been cancell?ed/i.test(body)) return 'cancelled';
  if (/\bmodifi(?:ed|cation)\b/i.test(subject) || /successfully modified/i.test(body)) return 'modified';
  if (/\bconfirm(?:ed|ation)\b/i.test(subject) || /reservation summary/i.test(text)) return 'confirmed';
  return 'unknown';
}

export function nightsBetween(checkIn: Date, checkOut: Date) {
  const start = Date.parse(`${bangkokDayKey(checkIn)}T00:00:00Z`);
  const end = Date.parse(`${bangkokDayKey(checkOut)}T00:00:00Z`);
  const nights = Math.round((end - start) / 86_400_000);
  return nights > 0 ? nights : null;
}

/** Hotel dates are civil dates in Asia/Bangkok (UTC+7, no daylight saving). */
export function bangkokDayKey(value: Date) {
  const shifted = new Date(value.getTime() + 7 * 60 * 60 * 1000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

export function bangkokClock(value: Date) {
  const shifted = new Date(value.getTime() + 7 * 60 * 60 * 1000);
  return `${String(shifted.getUTCHours()).padStart(2, '0')}:${String(shifted.getUTCMinutes()).padStart(2, '0')}:${String(shifted.getUTCSeconds()).padStart(2, '0')}`;
}

export function atBangkokHour(value: Date, hour: number) {
  const [year, month, day] = bangkokDayKey(value).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour - 7, 0, 0, 0));
}

/** Log value stored beside the queue status. The queue status itself stays PROCESSED, DUPLICATE, SKIPPED, or FAILED. */
export function importOutcome(action: 'created' | 'modified' | 'cancelled' | 'duplicate' | 'review' | 'stale', detail: string | null) {
  if (action === 'created') return 'IMPORTED';
  if (action === 'modified') return 'UPDATED';
  if (action === 'cancelled') return 'CANCELED';
  if (action === 'duplicate' || action === 'stale') return 'DUPLICATE';
  if (detail && /no imported reservation matches/i.test(detail)) return 'UNMATCHED';
  return 'NEEDS_REVIEW';
}

export type StayMatchStrategy = 'cloudbedsReservationId' | 'confirmationNumber' | 'sourceReservationId' | 'none';

/** Cloudbeds reservation id first. Confirmation number next. Source id only with the same booking source. Guest name is never a match. */
export function pickImportedStay<T extends ImportedStayMatch>(stays: T[], reservation: Pick<CloudbedsEmailReservation, 'source' | 'confirmationNumber' | 'sourceReservationId' | 'cloudbedsReservationId'>) {
  const confirmation = reservation.confirmationNumber.trim();
  const source = reservation.source.trim().toLowerCase();
  const byCloudbeds = reservation.cloudbedsReservationId ? stays.filter((stay) => stay.cloudbedsReservationId === reservation.cloudbedsReservationId) : [];
  if (byCloudbeds.length === 1) return { stay: byCloudbeds[0], ambiguous: false, strategy: 'cloudbedsReservationId' as const };
  if (byCloudbeds.length > 1) return { stay: null, ambiguous: true, strategy: 'cloudbedsReservationId' as const };
  const exact = stays.find((stay) => stay.confirmationNumber === confirmation && (stay.bookingSource ?? '').trim().toLowerCase() === source);
  if (exact) return { stay: exact, ambiguous: false, strategy: 'confirmationNumber' as const };
  const byConfirmation = stays.filter((stay) => stay.confirmationNumber === confirmation);
  if (byConfirmation.length === 1) return { stay: byConfirmation[0], ambiguous: false, strategy: 'confirmationNumber' as const };
  if (byConfirmation.length > 1) return { stay: null, ambiguous: true, strategy: 'confirmationNumber' as const };
  const bySourceId = reservation.sourceReservationId
    ? stays.filter((stay) => stay.sourceReservationId === reservation.sourceReservationId && (stay.bookingSource ?? '').trim().toLowerCase() === source)
    : [];
  if (bySourceId.length === 1) return { stay: bySourceId[0], ambiguous: false, strategy: 'sourceReservationId' as const };
  if (bySourceId.length > 1) return { stay: null, ambiguous: true, strategy: 'sourceReservationId' as const };
  return { stay: null, ambiguous: false, strategy: 'none' as const };
}

export function planStayNotice(input: {
  existing: {
    primaryGuestName: string;
    guestNotes: string | null;
    bookingSource: string | null;
    amountPaid: string | null;
    cloudbedsReservationId: string | null;
    cancelledAt: Date | null;
    latestNoticeAt: Date | null;
    checkedInAt?: Date | null;
    expectedCheckoutAt?: Date | null;
    roomType?: string | null;
    grandTotal?: string | null;
  } | null;
  reservation: CloudbedsEmailReservation;
  noticeAt: Date | null;
  reference: string | null;
}): StayNoticePlan {
  const { existing, reservation, noticeAt, reference } = input;
  if (reservation.kind === 'payment') return { action: 'review', detail: 'Payment notification. No reservation was created.', patch: null, replaceNights: false };
  if (!existing) {
    if (reservation.kind === 'confirmed') return { action: 'create', detail: null, patch: null, replaceNights: false };
    return { action: 'review', detail: `Manual review: no imported reservation matches confirmation ${reservation.confirmationNumber}.`, patch: null, replaceNights: false };
  }
  if (reservation.kind === 'unknown') return { action: 'review', detail: 'Manual review: the Cloudbeds notice type was not recognized.', patch: null, replaceNights: false };
  if ((reservation.kind === 'modified' || reservation.kind === 'cancelled') && !noticeAt && existing.latestNoticeAt) {
    return { action: 'review', detail: 'Manual review: this notice has no date, so it was not applied over the reservation already on file.', patch: null, replaceNights: false };
  }
  if (noticeAt && existing.latestNoticeAt && noticeAt.getTime() < existing.latestNoticeAt.getTime()) {
    return { action: 'stale', detail: 'Older than the reservation already on file. It was ignored so it would not overwrite newer data.', patch: null, replaceNights: false };
  }
  const reopensCanceled = Boolean(existing.cancelledAt && noticeAt && noticeAt.getTime() > existing.cancelledAt.getTime());
  if ((reservation.kind === 'confirmed' || reservation.kind === 'modified') && existing.cancelledAt && !reopensCanceled) {
    return { action: 'duplicate', detail: 'This notice is not newer than the cancellation already on file, so it did not reopen the reservation.', patch: null, replaceNights: false };
  }
  if (reservation.kind === 'cancelled') {
    const when = existing.cancelledAt ?? noticeAt ?? new Date();
    const note = reference ? `Cancelled from the forwarded Cloudbeds email ${reference}.` : 'Cancelled from the forwarded Cloudbeds email.';
    return {
      action: 'cancel',
      detail: null,
      replaceNights: false,
      patch: {
        cancelledAt: when,
        guestNotes: appendNote(existing.guestNotes, note),
        ...(nextCloudbedsId(existing.cloudbedsReservationId, reservation.cloudbedsReservationId) ? { cloudbedsReservationId: reservation.cloudbedsReservationId } : {}),
      },
    };
  }
  if (reservation.kind === 'confirmed' && !confirmedChanges(existing, reservation) && !reopensCanceled) {
    return { action: 'duplicate', detail: null, patch: null, replaceNights: false };
  }
  if (reservation.kind === 'modified' || reservation.kind === 'confirmed') {
    const note = reservation.kind === 'confirmed'
      ? (reference ? `Updated from the forwarded Cloudbeds confirmation ${reference}.` : 'Updated from the forwarded Cloudbeds confirmation.')
      : (reference ? `Modified from the forwarded Cloudbeds email ${reference}.` : 'Modified from the forwarded Cloudbeds email.');
    const amountPaid = reservation.amountPaid ?? existing.amountPaid;
    const checkOut = atBangkokHour(reservation.checkOut, 11);
    const patch: StayNoticePatch = {
      primaryGuestName: reservation.guestName.trim(),
      guestNotes: appendNote(existing.guestNotes, note),
      checkedInAt: reservation.checkIn,
      expectedCheckoutAt: checkOut,
      ...(reopensCanceled ? { cancelledAt: null } : {}),
      payment: {
        currency: reservation.currency,
        averageNightlyRate: reservation.averageNightlyRate,
        grandTotal: reservation.grandTotal,
        depositAmount: reservation.depositAmount,
        amountPaid,
        balanceDue: reservation.balanceDue,
        paymentMethod: reservation.paymentMethod,
      },
    };
    if (reservation.guestEmail) patch.guestEmail = reservation.guestEmail;
    if (reservation.source && (reservation.source !== 'Cloudbeds' || !existing.bookingSource)) patch.bookingSource = reservation.source;
    if (reservation.sourceReservationId) patch.sourceReservationId = reservation.sourceReservationId;
    const cloudbedsId = nextCloudbedsId(existing.cloudbedsReservationId, reservation.cloudbedsReservationId);
    if (cloudbedsId) patch.cloudbedsReservationId = cloudbedsId;
    if (reservation.roomType) patch.roomType = reservation.roomType;
    if (reservation.adults !== null) patch.adults = reservation.adults;
    if (reservation.children !== null) patch.children = reservation.children;
    const nights = nightsBetween(reservation.checkIn, reservation.checkOut);
    if (nights !== null) patch.nights = nights;
    else if (reservation.nights !== null) patch.nights = reservation.nights;
    if (reservation.currency) patch.currency = reservation.currency;
    if (reservation.averageNightlyRate) patch.averageNightlyRate = reservation.averageNightlyRate;
    if (reservation.grandTotal) patch.grandTotal = reservation.grandTotal;
    if (reservation.depositAmount !== null) patch.depositAmount = reservation.depositAmount;
    if (reservation.amountPaid !== null) patch.amountPaid = reservation.amountPaid;
    if (reservation.balanceDue) patch.balanceDue = reservation.balanceDue;
    return { action: 'modify', detail: null, patch, replaceNights: reservation.nightlyRates.length > 0 };
  }
  return { action: 'duplicate', detail: null, patch: null, replaceNights: false };
}

function confirmedChanges(existing: NonNullable<Parameters<typeof planStayNotice>[0]['existing']>, reservation: CloudbedsEmailReservation) {
  if (existing.primaryGuestName.trim() !== reservation.guestName.trim()) return true;
  if (existing.roomType && reservation.roomType && existing.roomType !== reservation.roomType) return true;
  if (existing.grandTotal && reservation.grandTotal && existing.grandTotal !== reservation.grandTotal) return true;
  if (existing.checkedInAt && bangkokDayKey(existing.checkedInAt) !== bangkokDayKey(reservation.checkIn)) return true;
  if (existing.expectedCheckoutAt && bangkokDayKey(existing.expectedCheckoutAt) !== bangkokDayKey(reservation.checkOut)) return true;
  if (reservation.amountPaid && existing.amountPaid && existing.amountPaid !== reservation.amountPaid) return true;
  return false;
}

/** Read the Cloudbeds reservation table from a forwarded HTML or plain-text message. */
export function parseCloudbedsReservation(input: { subject?: string | null; html?: string | null; text?: string | null }): CloudbedsEmailReservation | null {
  const subject = input.subject ?? '';
  const html = input.html ?? '';
  const text = input.text ?? '';
  const fields = html ? readReservationTable(html) : {};
  if (!fields.guestName && text) Object.assign(fields, readPlainLines(text));
  const guestName = fields.guestName?.trim() ?? '';
  const confirmationNumber = cleanIdentifier(fields.confirmationNumber ?? '') || confirmationFromSubject(subject);
  const checkIn = parseDayMonthYear(fields.checkIn ?? '');
  const checkOut = parseDayMonthYear(fields.checkOut ?? '');
  if (!guestName || !confirmationNumber || !checkIn || !checkOut || checkOut.getTime() <= checkIn.getTime()) return null;
  const moneyFields = ['averageNightlyRate', 'grandTotal', 'depositAmount', 'amountPaid', 'balanceDue'] as const;
  const money: Record<string, { amount: string; currency: string } | null> = {};
  for (const field of moneyFields) money[field] = parseMoney(fields[field] ?? '');
  const nightlyRates = (fields.nightly ?? []).map((rate) => ({ night: rate.night, amount: rate.amount, currency: rate.currency }));
  const currency = money.grandTotal?.currency || money.averageNightlyRate?.currency || money.balanceDue?.currency || nightlyRates[0]?.currency || fields.currency || null;
  const averageNightlyRate = money.averageNightlyRate?.amount ?? averageAmount(nightlyRates);
  const body = `${text}\n${html ? stripTags(html) : ''}`;
  return {
    kind: cloudbedsNoticeKind(subject, body),
    guestName,
    guestEmail: emailOrNull(fields.guestEmail ?? ''),
    source: fields.source?.trim() || inferChannel(subject, text, html) || 'Cloudbeds',
    confirmationNumber,
    sourceReservationId: cleanIdentifier(fields.sourceReservationId ?? '') || null,
    cloudbedsReservationId: cloudbedsReservationIdFrom(`${html}\n${text}`),
    checkIn,
    checkOut,
    nights: countOrNull(fields.nights ?? '') ?? nightsBetween(checkIn, checkOut),
    roomType: collapse(fields.roomType ?? '') || null,
    roomNumber: roomOrNull(fields.roomNumber ?? ''),
    adults: countOrNull(fields.adults ?? ''),
    children: countOrNull(fields.children ?? ''),
    currency,
    averageNightlyRate,
    nightlyRates,
    grandTotal: money.grandTotal?.amount ?? null,
    depositAmount: money.depositAmount?.amount ?? null,
    amountPaid: money.amountPaid?.amount ?? null,
    balanceDue: money.balanceDue?.amount ?? null,
    paymentMethod: collapse(fields.paymentMethod ?? '') || null,
  };
}

export function originalCloudbedsHeaders(text: string) {
  const lines = text.split(/\r?\n/);
  let from: string | null = null;
  let subject: string | null = null;
  let noticeAt: Date | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const fromMatch = /^(?:>\s*)?From:\s*.*<([^>]+)>/i.exec(lines[index].trim()) ?? /^(?:>\s*)?From:\s*(\S+@\S+)/i.exec(lines[index].trim());
    const address = fromMatch?.[1]?.replace(/^mailto:/i, '').trim() ?? '';
    if (!/cloudbeds\.com$/i.test(address)) continue;
    let dateLine = '';
    let subjectLine = '';
    for (let cursor = index + 1; cursor < Math.min(lines.length, index + 12); cursor += 1) {
      const line = lines[cursor].trim().replace(/^>\s*/, '');
      if (/^Date:\s*/i.test(line)) dateLine = line.replace(/^Date:\s*/i, '');
      else if (/^Subject:\s*/i.test(line)) {
        subjectLine = line.replace(/^Subject:\s*/i, '');
        for (let next = cursor + 1; next < lines.length; next += 1) {
          const continuation = lines[next].trim().replace(/^>\s*/, '');
          if (!continuation || /^(From|Date|Subject|To|Cc):/i.test(continuation) || /^-{5,}/.test(continuation)) break;
          subjectLine += ` ${continuation}`;
        }
      }
    }
    from = address;
    subject = collapse(subjectLine) || null;
    noticeAt = parseLooseDate(dateLine);
  }
  return { from, subject, noticeAt };
}

type ParsedMail = Awaited<ReturnType<typeof simpleParser>>;
type WalkedMail = { message: ParsedMail; raw: Buffer; depth: number; filename: string | null };

const NESTED_MESSAGE_LIMIT = 32;

export type ExtractedCloudbedsNotice = {
  messageId: string | null;
  subject: string | null;
  from: string | null;
  to: string | null;
  date: Date | null;
  inReplyTo: string | null;
  references: string | null;
  noticeAt: Date | null;
  kind: CloudbedsNoticeKind;
  reservation: CloudbedsEmailReservation | null;
  raw: Buffer;
  nestingDepth: number;
  attachmentFilename: string | null;
};

export type CloudbedsExtraction = {
  outer: { messageId: string | null; subject: string | null; from: string | null; date: Date | null };
  notices: ExtractedCloudbedsNotice[];
  duplicates: number;
  wrappers: number;
  parts: number;
  attachments: number;
  maxDepth: number;
  failedAttachments: number;
};

function isAttachedMessage(attachment: { contentType?: string; filename?: string }) {
  const type = (attachment.contentType ?? '').toLowerCase();
  return type === 'message/rfc822' || type.startsWith('message/rfc822;') || (attachment.filename ?? '').toLowerCase().endsWith('.eml');
}

/** Walk the outer message and any attached .eml files. Depth is only a cycle guard; sibling attachments are not capped. */
type WalkStats = { count: number; parts: number; attachments: number; maxDepth: number; failedAttachments: number };

async function walkMail(source: Buffer | string, depth = 0, seen = new Set<string>(), duplicates: WalkStats = { count: 0, parts: 0, attachments: 0, maxDepth: 0, failedAttachments: 0 }, filename: string | null = null): Promise<WalkedMail[]> {
  const raw = Buffer.isBuffer(source) ? source : Buffer.from(source);
  const fingerprint = createHash('sha256').update(raw).digest('hex');
  duplicates.parts += 1;
  duplicates.maxDepth = Math.max(duplicates.maxDepth, depth);
  if (seen.has(fingerprint)) {
    duplicates.count += 1;
    return [];
  }
  seen.add(fingerprint);
  let message: ParsedMail;
  try {
    message = await simpleParser(raw);
  } catch {
    duplicates.failedAttachments += 1;
    return [];
  }
  const nested: WalkedMail[] = [];
  if (depth < NESTED_MESSAGE_LIMIT) {
    for (const attachment of message.attachments ?? []) {
      duplicates.attachments += 1;
      if (!isAttachedMessage(attachment) || !attachment.content?.length) continue;
      try {
        nested.push(...await walkMail(attachment.content, depth + 1, seen, duplicates, attachment.filename ?? null));
      } catch {
        duplicates.failedAttachments += 1;
      }
    }
  }
  return [{ message, raw, depth, filename }, ...nested];
}

function describeMail(message: ParsedMail) {
  const html = typeof message.html === 'string' ? message.html : '';
  const text = message.text ?? '';
  const embedded = originalCloudbedsHeaders(`${text}\n${stripTags(html)}`);
  const headerFrom = message.from?.value?.[0]?.address ?? null;
  const headerIsCloudbeds = /@cloudbeds\.com$/i.test(headerFrom ?? '');
  const from = embedded.from ?? (headerIsCloudbeds ? headerFrom : null);
  const subject = embedded.subject || (from || headerIsCloudbeds ? message.subject ?? '' : '');
  const noticeAt = embedded.noticeAt ?? (from || headerIsCloudbeds ? message.date ?? null : null);
  return {
    message,
    headerFrom,
    from,
    subject,
    noticeAt,
    reservation: parseCloudbedsReservation({ subject: subject || message.subject || '', html, text }),
  };
}

export async function readCloudbedsMessage(source: Buffer | string) {
  const extracted = await extractCloudbedsNotices(source);
  const chosen = extracted.notices.find((item) => item.reservation) ?? extracted.notices[0];
  return {
    messageId: extracted.outer.messageId ?? chosen?.messageId ?? null,
    subject: chosen?.subject ?? null,
    from: chosen?.from ?? extracted.outer.from,
    date: extracted.outer.date,
    noticeAt: chosen?.noticeAt ?? null,
    outer: extracted.outer,
    reservation: chosen?.reservation ?? null,
  };
}

function addressList(value: ParsedMail['to']) {
  if (!value) return null;
  const list = Array.isArray(value) ? value : [value];
  const addresses = list.flatMap((item) => item.value.map((entry) => entry.address).filter((address): address is string => Boolean(address)));
  return addresses.length ? addresses.join(', ') : null;
}

function referenceList(value: ParsedMail['references']) {
  if (!value) return null;
  const list = Array.isArray(value) ? value : [value];
  const cleaned = list.map((item) => item.trim()).filter(Boolean);
  return cleaned.length ? cleaned.join(' ') : null;
}

function noticeIdentity(item: ReturnType<typeof describeMail>) {
  const id = item.message.messageId?.replace(/\s+/g, ' ').trim();
  if (id) return `id:${id.slice(0, 900)}`;
  const text = collapse(`${item.subject}\n${item.from ?? ''}\n${item.noticeAt?.toISOString() ?? ''}\n${item.message.text ?? ''}\n${typeof item.message.html === 'string' ? stripTags(item.message.html) : ''}`).toLowerCase();
  return `fp:${createHash('sha256').update(text).digest('hex')}`;
}

function reservationEventKey(reservation: CloudbedsEmailReservation) {
  const day = (value: Date) => `${value.getFullYear()}-${value.getMonth()}-${value.getDate()}`;
  return [reservation.kind, reservation.confirmationNumber, reservation.guestName.trim().toLowerCase(), day(reservation.checkIn), day(reservation.checkOut)].join('|');
}

function toNotice(item: ReturnType<typeof describeMail> & { raw: Buffer; nestingDepth?: number; attachmentFilename?: string | null }, kind: CloudbedsNoticeKind): ExtractedCloudbedsNotice {
  const reservation = item.reservation && item.reservation.kind !== 'payment' ? item.reservation : null;
  return {
    messageId: item.message.messageId?.replace(/\s+/g, ' ').trim() || null,
    subject: item.subject || item.message.subject || null,
    from: item.from ?? item.headerFrom,
    to: addressList(item.message.to),
    date: item.message.date ?? null,
    inReplyTo: item.message.inReplyTo?.trim() || null,
    references: referenceList(item.message.references),
    noticeAt: item.noticeAt ?? (kind === 'payment' ? item.message.date ?? null : null),
    kind: reservation?.kind ?? kind,
    reservation,
    raw: item.raw,
    nestingDepth: item.nestingDepth ?? 0,
    attachmentFilename: item.attachmentFilename ?? null,
  };
}

/** Every distinct Cloudbeds notice inside a forwarded message. The outer Gmail wrapper is not its own reservation. */
export async function extractCloudbedsNotices(source: Buffer | string): Promise<CloudbedsExtraction> {
  const byteDuplicates: WalkStats = { count: 0, parts: 0, attachments: 0, maxDepth: 0, failedAttachments: 0 };
  const walked = await walkMail(source, 0, new Set<string>(), byteDuplicates);
  const outerMessage = walked[0]?.message;
  const outerFrom = outerMessage?.from?.value?.[0]?.address ?? null;
  const described = walked.map((item) => ({ ...describeMail(item.message), raw: item.raw, nestingDepth: item.depth, attachmentFilename: item.filename }));
  let duplicates = byteDuplicates.count;
  const byIdentity = new Map<string, (typeof described)[number]>();
  for (const item of described) {
    const key = noticeIdentity(item);
    if (byIdentity.has(key)) {
      duplicates += 1;
      continue;
    }
    byIdentity.set(key, item);
  }
  const unique = [...byIdentity.values()];
  const reservations = unique.filter((item) => item.reservation && item.reservation.kind !== 'payment');
  const ranked = [...reservations].sort((left, right) => Number(/@cloudbeds\.com$/i.test(right.from ?? right.headerFrom ?? '')) - Number(/@cloudbeds\.com$/i.test(left.from ?? left.headerFrom ?? '')));
  const kept: typeof unique = [];
  const seenEvents = new Set<string>();
  for (const item of ranked) {
    const key = reservationEventKey(item.reservation!);
    if (seenEvents.has(key)) {
      duplicates += 1;
      continue;
    }
    seenEvents.add(key);
    kept.push(item);
  }
  const payments = unique.filter((item) => {
    const kind = cloudbedsNoticeKind(item.subject || item.message.subject || '', `${item.message.text ?? ''}\n${typeof item.message.html === 'string' ? stripTags(item.message.html) : ''}`);
    return kind === 'payment' && !kept.includes(item);
  });
  const others = unique.filter((item) => {
    if (item.reservation || payments.includes(item) || kept.includes(item)) return false;
    const who = `${item.from ?? ''} ${item.headerFrom ?? ''} ${item.subject ?? ''} ${item.message.subject ?? ''}`;
    return /cloudbeds|reservation|booking\.com/i.test(who);
  });
  const notices = [...kept, ...payments, ...others].map((item) => {
    const kind = cloudbedsNoticeKind(item.subject || item.message.subject || '', `${item.message.text ?? ''}\n${typeof item.message.html === 'string' ? stripTags(item.message.html) : ''}`);
    return toNotice(item, kind);
  });
  notices.sort((left, right) => (left.noticeAt?.getTime() ?? left.date?.getTime() ?? Number.POSITIVE_INFINITY) - (right.noticeAt?.getTime() ?? right.date?.getTime() ?? Number.POSITIVE_INFINITY));
  const wrappers = walked.length > 1 ? described.filter((item, index) => index === 0 && !kept.includes(item) && !payments.includes(item)).length : 0;
  if (!notices.length && described[0]) notices.push(toNotice(described[0], cloudbedsNoticeKind(described[0].subject || described[0].message.subject || '', described[0].message.text ?? '')));
  return {
    outer: {
      messageId: outerMessage?.messageId?.replace(/\s+/g, ' ').trim() || null,
      subject: outerMessage?.subject?.trim() || null,
      from: outerFrom,
      date: outerMessage?.date ?? null,
    },
    notices,
    duplicates,
    wrappers,
    parts: byteDuplicates.parts,
    attachments: byteDuplicates.attachments,
    maxDepth: byteDuplicates.maxDepth,
    failedAttachments: byteDuplicates.failedAttachments,
  };
}

function readReservationTable(html: string) {
  const document = parse(html);
  let match: HTMLElement | null = null;
  let size = Number.POSITIVE_INFINITY;
  for (const table of document.querySelectorAll('table')) {
    const text = collapse(table.text).toLowerCase();
    if (!text.includes('confirmation number') || !text.includes('grand total')) continue;
    if (table.text.length < size) {
      match = table;
      size = table.text.length;
    }
  }
  return match ? rowsToFields(leafRows(match)) : {};
}

function leafRows(table: HTMLElement) {
  const rows: string[][] = [];
  for (const tr of table.querySelectorAll('tr')) {
    const cells = elementChildren(tr, ['TD', 'TH']);
    if (!cells.length || cells.some((cell) => cell.querySelector('table'))) continue;
    const values = cells.map((cell) => collapse(cell.text));
    if (values.some(Boolean)) rows.push(values);
  }
  return rows;
}

function rowsToFields(rows: string[][]) {
  const fields: Record<string, string> & { nightly?: CloudbedsNightlyRate[] } = {};
  let expectDates = false;
  for (const cells of rows) {
    const labels = cells.map((cell) => labelOf(cell));
    if (labels.includes('check-in') && labels.includes('check-out')) {
      expectDates = true;
      continue;
    }
    if (expectDates && parseDayMonthYear(cells[0] ?? '') && parseDayMonthYear(cells[1] ?? '')) {
      fields.checkIn = cells[0];
      fields.checkOut = cells[1];
      if (cells[2]) fields.nights = cells[2];
      expectDates = false;
      continue;
    }
    expectDates = false;
    if (cells.length >= 2 && LABELS[labelOf(cells[0])]) fields[LABELS[labelOf(cells[0])]] = cells.slice(1).filter(Boolean).join(' ').trim();
    for (const cell of cells) {
      const adults = /adults:\s*(\d+)/i.exec(cell);
      const children = /children:\s*(\d+)/i.exec(cell);
      if (adults) fields.adults = adults[1];
      if (children) fields.children = children[1];
    }
    const night = parseDayMonthYear(cells[0] ?? '');
    const rate = parseMoney(cells[1] ?? '');
    if (night && rate && !parseDayMonthYear(cells[1] ?? '')) {
      fields.nightly ??= [];
      fields.nightly.push({ night, amount: rate.amount, currency: rate.currency });
    }
  }
  return fields;
}

function readPlainLines(text: string) {
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const rows: string[][] = [];
  let expectDates = false;
  for (const line of lines) {
    if (/check-in/i.test(line) && /check-out/i.test(line)) {
      expectDates = true;
      rows.push(['Check-in', 'Check-out', 'Days']);
      continue;
    }
    if (expectDates) {
      const dates = /(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})(?:\s+(\d+))?/.exec(line);
      if (dates) rows.push([dates[1], dates[2], dates[3] ?? '']);
      expectDates = false;
      continue;
    }
    const nightly = /^(\d{2}\/\d{2}\/\d{4})\b.*?\s((?:[A-Z]{3}|฿)\s*[\d,]+(?:\.\d{1,2})?)$/.exec(line);
    if (nightly) {
      rows.push([nightly[1], nightly[2]]);
      continue;
    }
    const labeled = matchPlainLabel(line);
    rows.push(labeled ?? [line]);
  }
  return rowsToFields(rows);
}

function matchPlainLabel(line: string): [string, string] | null {
  const cleaned = collapse(line);
  const lower = cleaned.toLowerCase();
  for (const label of PLAIN_LABELS) {
    if (!lower.startsWith(label)) continue;
    const rest = cleaned.slice(label.length).replace(/^:\s*/, '').trim();
    if (!rest) return null;
    return [label.replace(/\b\w/g, (letter) => letter.toUpperCase()), rest];
  }
  return null;
}

function elementChildren(node: HTMLElement, tags: string[]) {
  return node.childNodes.filter((child): child is HTMLElement => tags.includes((child as HTMLElement).tagName?.toUpperCase?.() ?? ''));
}

function labelOf(value: string) {
  return collapse(value).replace(/:$/, '').toLowerCase();
}

function collapse(value: string) {
  return value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function stripTags(html: string) {
  return html.replace(/<[^>]+>/g, '\n');
}

function parseDayMonthYear(value: string) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})\b/.exec(collapse(value));
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day, 7, 0, 0, 0));
  if (bangkokDayKey(date) !== `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`) return null;
  return date;
}

function parseLooseDate(value: string) {
  const cleaned = collapse(value).replace(/\s+at\s+/i, ' ');
  if (!cleaned) return null;
  const date = new Date(cleaned);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseMoney(value: string) {
  const text = collapse(value.replace(/฿/g, 'THB '));
  const match = /^([A-Z]{3})\s+([\d,]+(?:\.\d{1,2})?)$/.exec(text);
  if (!match) return null;
  const [whole, fraction = ''] = match[2].replace(/,/g, '').split('.');
  if (!/^\d+$/.test(whole) || (fraction && !/^\d{1,2}$/.test(fraction))) return null;
  return { currency: match[1], amount: `${whole}.${(fraction + '00').slice(0, 2)}` };
}

function averageAmount(rates: { amount: string }[]) {
  if (!rates.length) return null;
  const cents = rates.reduce((sum, rate) => {
    const [whole, fraction = ''] = rate.amount.split('.');
    return sum + Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  }, 0);
  const average = Math.round(cents / rates.length);
  return `${Math.trunc(average / 100)}.${String(average % 100).padStart(2, '0')}`;
}

function confirmationFromSubject(subject: string) {
  const match = /#\s*([A-Z0-9][A-Z0-9-]{3,})/i.exec(subject);
  return match?.[1] ?? '';
}

function cloudbedsReservationIdFrom(value: string) {
  const match = /reservations\/(\d{4,})/i.exec(value);
  return match?.[1] ?? null;
}

function inferChannel(subject: string, text: string, html: string) {
  const blob = `${subject}\n${text}\n${html}`;
  if (/booking\.com/i.test(blob)) return 'Booking.com';
  if (/\bexpedia\b/i.test(blob)) return 'Expedia';
  if (/\bairbnb\b/i.test(blob)) return 'Airbnb';
  return null;
}

function cleanIdentifier(value: string) {
  const withoutLink = collapse(value).replace(/<[^>]*>/g, ' ').trim();
  return withoutLink.split(/\s+/)[0] ?? '';
}

function nextCloudbedsId(current: string | null, incoming: string | null) {
  if (!incoming) return null;
  if (!current || current === incoming) return incoming;
  return null;
}

function appendNote(current: string | null, line: string) {
  return current?.includes(line) ? current : `${current ? `${current.trim()} ` : ''}${line}`;
}

function roomOrNull(value: string) {
  const text = collapse(value);
  if (!text || /^(n\/?a|none|not assigned|unassigned|tbd|—|-)$/i.test(text)) return null;
  return text.replace(/^room\s+/i, '').trim() || null;
}

function emailOrNull(value: string) {
  const text = collapse(value);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? text : null;
}

function countOrNull(value: string) {
  const match = /^(\d{1,2})$/.exec(collapse(value));
  return match ? Number(match[1]) : null;
}
