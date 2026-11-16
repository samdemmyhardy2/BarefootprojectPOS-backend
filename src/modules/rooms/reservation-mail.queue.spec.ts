import { randomUUID } from 'node:crypto';
import { planStayNotice, pickImportedStay, readCloudbedsMessage, type CloudbedsEmailReservation } from './cloudbeds-email';
import { inboundMessageKey, mailConcurrency, mailLookback, mailMaxAttempts, mailResultForImport, mailRetryDelayMs, pumpMailQueue, TemporaryMailError, type MailQueueStore, type QueuedMail } from './reservation-mail.queue';

type MemoryStay = {
  id: string;
  bookingSource: string | null;
  confirmationNumber: string | null;
  sourceReservationId: string | null;
  cloudbedsReservationId: string | null;
  primaryGuestName: string;
  guestNotes: string | null;
  amountPaid: string | null;
  grandTotal: string | null;
  depositAmount: string | null;
  cancelledAt: Date | null;
  latestNoticeAt: Date | null;
  events: string[];
};

class StayBook {
  readonly stays: MemoryStay[] = [];
  readonly calls = new Map<string, number>();
  readonly failOnce = new Set<string>();
  readonly failAlways = new Set<string>();
  private readonly tails = new Map<string, Promise<unknown>>();

  import(reservation: CloudbedsEmailReservation, noticeAt: Date | null, reference: string) {
    const key = reservation.confirmationNumber;
    const previous = this.tails.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      this.calls.set(key, (this.calls.get(key) ?? 0) + 1);
      if (this.failAlways.has(key) || this.failOnce.delete(key)) throw new TemporaryMailError('database is unavailable');
      const picked = pickImportedStay(this.stays, reservation);
      if (picked.ambiguous) return { action: 'review' as const, stayId: null, detail: `Manual review: more than one reservation matches confirmation ${key}.` };
      const existing = picked.stay ?? null;
      const decision = planStayNotice({
        existing: existing ? {
          primaryGuestName: existing.primaryGuestName,
          guestNotes: existing.guestNotes,
          bookingSource: existing.bookingSource,
          amountPaid: existing.amountPaid,
          cloudbedsReservationId: existing.cloudbedsReservationId,
          cancelledAt: existing.cancelledAt,
          latestNoticeAt: existing.latestNoticeAt,
        } : null,
        reservation,
        noticeAt,
        reference,
      });
      if (decision.action === 'review' || decision.action === 'stale' || decision.action === 'duplicate') {
        return { action: decision.action, stayId: existing?.id ?? null, detail: decision.detail };
      }
      if (decision.action === 'cancel' && existing && decision.patch) {
        existing.guestNotes = decision.patch.guestNotes ?? existing.guestNotes;
        existing.cancelledAt = decision.patch.cancelledAt ?? existing.cancelledAt;
        existing.cloudbedsReservationId = decision.patch.cloudbedsReservationId ?? existing.cloudbedsReservationId;
        existing.latestNoticeAt = noticeAt ?? existing.latestNoticeAt;
        existing.events.push('cancelled');
        return { action: 'cancelled' as const, stayId: existing.id, detail: null };
      }
      if (decision.action === 'modify' && existing && decision.patch) {
        existing.primaryGuestName = decision.patch.primaryGuestName ?? existing.primaryGuestName;
        existing.guestNotes = decision.patch.guestNotes ?? existing.guestNotes;
        if (decision.patch.amountPaid !== undefined) existing.amountPaid = decision.patch.amountPaid;
        if (decision.patch.grandTotal) existing.grandTotal = decision.patch.grandTotal;
        existing.latestNoticeAt = noticeAt ?? existing.latestNoticeAt;
        existing.events.push('modified');
        return { action: 'modified' as const, stayId: existing.id, detail: null };
      }
      const stay: MemoryStay = {
        id: randomUUID(),
        bookingSource: reservation.source,
        confirmationNumber: reservation.confirmationNumber,
        sourceReservationId: reservation.sourceReservationId,
        cloudbedsReservationId: reservation.cloudbedsReservationId,
        primaryGuestName: reservation.guestName,
        guestNotes: 'Imported from a forwarded Cloudbeds email.',
        amountPaid: reservation.amountPaid,
        grandTotal: reservation.grandTotal,
        depositAmount: reservation.depositAmount,
        cancelledAt: null,
        latestNoticeAt: noticeAt,
        events: ['created'],
      };
      this.stays.push(stay);
      return { action: 'created' as const, stayId: stay.id, detail: null };
    });
    this.tails.set(key, run);
    return run;
  }
}

class MemoryMailStore implements MailQueueStore {
  readonly jobs: QueuedMail[] = [];

  accept(input: { messageId: string; rawMime: string }): 'queued' | 'stored' {
    if (this.jobs.some((job) => job.messageId === input.messageId)) return 'stored';
    this.jobs.push({
      id: `job-${this.jobs.length + 1}`,
      messageId: input.messageId,
      mailbox: 'INBOX',
      uid: this.jobs.length + 1,
      rawMime: input.rawMime,
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: null,
      claimedAt: null,
      error: null,
      subject: null,
      fromAddress: null,
      receivedAt: null,
      noticeAt: null,
      noticeKind: null,
      confirmationNumber: null,
      source: null,
      stayId: null,
      outcome: null,
      createdAt: this.jobs.length + 1,
    });
    return 'queued';
  }

  async claim(limit: number, now: number) {
    const ready = this.jobs
      .filter((job) => job.status === 'PENDING' && (job.nextAttemptAt == null || job.nextAttemptAt <= now))
      .sort((left, right) => left.createdAt - right.createdAt)
      .slice(0, limit);
    for (const job of ready) {
      job.status = 'PROCESSING';
      job.claimedAt = now;
    }
    return ready.map((job) => ({ ...job }));
  }

  async save(job: QueuedMail) {
    const index = this.jobs.findIndex((item) => item.id === job.id);
    if (index < 0) throw new Error(`Missing queued email ${job.id}`);
    this.jobs[index] = { ...job };
  }

  async recover(staleBefore: number | null) {
    let recovered = 0;
    for (const job of this.jobs) {
      if (job.status !== 'PROCESSING') continue;
      if (staleBefore != null && (job.claimedAt ?? 0) >= staleBefore) continue;
      job.status = 'PENDING';
      job.claimedAt = null;
      job.nextAttemptAt = null;
      recovered += 1;
    }
    return recovered;
  }

  async readyCount(now: number) {
    return this.jobs.filter((job) => job.status === 'PENDING' && (job.nextAttemptAt == null || job.nextAttemptAt <= now)).length;
  }

  async soonestRetry(now: number) {
    const times = this.jobs.flatMap((job) => job.status === 'PENDING' && job.nextAttemptAt != null && job.nextAttemptAt > now ? [job.nextAttemptAt] : []);
    return times.length ? Math.min(...times) : null;
  }
}

function reservationTable(guest: string, confirmation: string, grand: string) {
  return `<table><tr><td>Guest Name</td><td>${guest}</td></tr><tr><td>Email</td><td>guest@example.com</td></tr><tr><td>Confirmation Number</td><td>${confirmation}</td></tr><tr><td>Source</td><td>Website/Booking Engine</td></tr><tr><td>Check-in</td><td>Check-out</td><td>Days</td></tr><tr><td>02/03/2027</td><td>05/03/2027</td><td>3</td></tr><tr><td>Grand Total</td><td>THB ${grand}</td></tr><tr><td>Deposit Amount</td><td>THB ${grand}</td></tr><tr><td>Amount Paid</td><td>THB 0.00</td></tr><tr><td>Balance Due</td><td>THB ${grand}</td></tr></table>`;
}

function cloudbedsMime(input: { id: string; subject: string; guest: string; confirmation: string; grand: string; date: string }) {
  return [
    'From: Cloudbeds <admin@cloudbeds.com>',
    `Date: ${input.date}`,
    `Message-ID: <${input.id}>`,
    `Subject: ${input.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset="UTF-8"',
    '',
    reservationTable(input.guest, input.confirmation, input.grand),
  ].join('\r\n');
}

function forwardedMime(id: string, inner: string) {
  return [
    'From: Front Desk <barefootproject.kohphayam@gmail.com>',
    'Date: Mon, 2 Nov 2026 18:42:48 +0700',
    `Message-ID: <${id}>`,
    'Subject: ',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="outer"',
    '',
    '--outer',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    'Forwarded with no reservation in the body.',
    '--outer',
    'Content-Type: message/rfc822',
    'Content-Disposition: attachment; filename="reservation.eml"',
    '',
    inner,
    '--outer--',
    '',
  ].join('\r\n');
}

function confirmation(series: number) {
  return `880000${String(series).padStart(6, '0')}`;
}

describe('reservation mail queue', () => {
  it('keeps concurrency, retries, and message identity bounded', () => {
    expect(mailConcurrency(undefined)).toBe(3);
    expect(mailConcurrency('4')).toBe(4);
    expect(mailConcurrency('90')).toBe(5);
    expect(mailMaxAttempts('0')).toBe(1);
    expect(mailLookback('40')).toBe(90);
    expect(mailRetryDelayMs(1, 2_000)).toBe(2_000);
    expect(mailRetryDelayMs(3, 2_000)).toBe(8_000);
    const raw = Buffer.from('same bytes');
    expect(inboundMessageKey(' <abc@cloudbeds.com> ', raw)).toBe('<abc@cloudbeds.com>');
    expect(inboundMessageKey(' ', raw)).toBe(inboundMessageKey(null, raw));
    expect(inboundMessageKey(null, raw)).not.toBe(inboundMessageKey(null, Buffer.from('other bytes')));
  });

  it('never runs more jobs than the configured concurrency', async () => {
    const store = new MemoryMailStore();
    for (let index = 0; index < 6; index += 1) store.accept({ messageId: `slow-${index}@cloudbeds.com`, rawMime: 'pending' });
    let active = 0;
    let maxActive = 0;
    const totals = await pumpMailQueue({
      store,
      concurrency: 2,
      maxAttempts: 3,
      baseDelayMs: 10,
      now: () => 1,
      stopWhenIdle: true,
      work: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active -= 1;
        return { terminal: 'PROCESSED', error: null };
      },
    });
    expect(maxActive).toBe(2);
    expect(totals.maxInFlight).toBe(2);
    expect(store.jobs.every((job) => job.status === 'PROCESSED')).toBe(true);
  });

  it('retries a temporary failure without a second stay and stops a permanent failure', async () => {
    const store = new MemoryMailStore();
    store.accept({ messageId: 'again@cloudbeds.com', rawMime: 'temporary' });
    store.accept({ messageId: 'broken@cloudbeds.com', rawMime: 'permanent' });
    const calls = new Map<string, number>();
    let clock = 1_000;
    await pumpMailQueue({
      store,
      concurrency: 2,
      maxAttempts: 5,
      baseDelayMs: 25,
      now: () => clock,
      stopWhenIdle: true,
      advanceTo: (time) => { clock = time; },
      work: async (job) => {
        const count = (calls.get(job.messageId) ?? 0) + 1;
        calls.set(job.messageId, count);
        if (job.messageId.startsWith('again') && count < 3) throw new TemporaryMailError('database is unavailable');
        if (job.messageId.startsWith('broken')) throw new Error('The message structure is not supported.');
        return { terminal: 'PROCESSED', error: null };
      },
    });
    const retried = store.jobs.find((job) => job.messageId === 'again@cloudbeds.com');
    const broken = store.jobs.find((job) => job.messageId === 'broken@cloudbeds.com');
    expect(retried?.status).toBe('PROCESSED');
    expect(retried?.attempts).toBe(3);
    expect(calls.get('again@cloudbeds.com')).toBe(3);
    expect(broken?.status).toBe('FAILED');
    expect(calls.get('broken@cloudbeds.com')).toBe(1);
  });

  it('gives up on a temporary failure after the attempt limit and keeps the message', async () => {
    const store = new MemoryMailStore();
    store.accept({ messageId: 'stuck@cloudbeds.com', rawMime: 'still failing' });
    let calls = 0;
    let clock = 5_000;
    await pumpMailQueue({
      store,
      concurrency: 1,
      maxAttempts: 5,
      baseDelayMs: 10,
      now: () => clock,
      stopWhenIdle: true,
      advanceTo: (time) => { clock = time; },
      work: async () => {
        calls += 1;
        throw new TemporaryMailError('database is unavailable');
      },
    });
    expect(calls).toBe(5);
    expect(store.jobs[0]).toMatchObject({ status: 'FAILED', attempts: 5, error: 'database is unavailable' });
    expect(store.jobs[0].rawMime).toBe('still failing');
  });

  it('imports 90 emails that arrive together without duplicates or dropped messages', async () => {
    const confirmedDate = 'Tue, 16 Jun 2026 14:26:26 +0000';
    const modifiedDate = 'Tue, 16 Jun 2026 15:26:26 +0000';
    const cancelledDate = 'Tue, 16 Jun 2026 16:26:26 +0000';
    const messages: Array<{ messageId: string; rawMime: string }> = [];
    const pushConfirmed = (series: number, date = confirmedDate) => {
      const number = confirmation(series);
      const id = `confirmed-${number}@cloudbeds.com`;
      messages.push({ messageId: id, rawMime: cloudbedsMime({ id, subject: `Reservation CONFIRMED - Guest ${number} - Reservation #${number}`, guest: `Guest ${number}`, confirmation: number, grand: '900.00', date }) });
      return number;
    };
    const early = [101, 102, 103, 104].map((series) => confirmation(series));
    for (const number of early) {
      const id = `modified-early-${number}@cloudbeds.com`;
      messages.push({ messageId: id, rawMime: cloudbedsMime({ id, subject: `Reservation MODIFIED - Guest ${number} Updated - Reservation #${number}`, guest: `Guest ${number} Updated`, confirmation: number, grand: '1200.00', date: modifiedDate }) });
    }
    const original = Array.from({ length: 44 }, (_, index) => pushConfirmed(index + 1));
    for (const number of early) pushConfirmed(Number(number.slice(-3)));
    const modified = original.slice(0, 8);
    for (const number of modified) {
      const id = `modified-${number}@cloudbeds.com`;
      messages.push({ messageId: id, rawMime: cloudbedsMime({ id, subject: `Reservation MODIFIED - Guest ${number} Updated - Reservation #${number}`, guest: `Guest ${number} Updated`, confirmation: number, grand: '1200.00', date: modifiedDate }) });
    }
    const cancelled = original.slice(8, 14);
    for (const number of cancelled) {
      const id = `cancelled-${number}@cloudbeds.com`;
      messages.push({ messageId: id, rawMime: cloudbedsMime({ id, subject: `Reservation CANCELLED - Guest ${number} - Reservation #${number}`, guest: `Guest ${number}`, confirmation: number, grand: '900.00', date: cancelledDate }) });
    }
    const duplicated = original.slice(14, 22);
    for (const number of duplicated) {
      const id = `duplicate-${number}@cloudbeds.com`;
      messages.push({ messageId: id, rawMime: cloudbedsMime({ id, subject: `Reservation CONFIRMED - Guest ${number} - Reservation #${number}`, guest: `Guest ${number}`, confirmation: number, grand: '900.00', date: confirmedDate }) });
    }
    const nested = [201, 202, 203, 204].map((series) => confirmation(series));
    for (const number of nested) {
      const innerId = `nested-inner-${number}@cloudbeds.com`;
      const outerId = `nested-${number}@gmail.com`;
      const inner = cloudbedsMime({ id: innerId, subject: `Reservation CONFIRMED - Guest ${number} - Reservation #${number}`, guest: `Guest ${number}`, confirmation: number, grand: '900.00', date: confirmedDate });
      messages.push({ messageId: outerId, rawMime: forwardedMime(outerId, inner) });
    }
    for (let index = 0; index < 4; index += 1) {
      messages.push({ messageId: `malformed-${index}@example.com`, rawMime: `this is not a reservation ${index}\r\n\r\nno table here` });
    }
    const temporary = [301, 302].map((series) => confirmation(series));
    for (const number of temporary) pushConfirmed(Number(number.slice(-3)));
    const extra = [401, 402].map((series) => pushConfirmed(series));
    for (const number of original.slice(0, 4)) messages.push({ messageId: `confirmed-${number}@cloudbeds.com`, rawMime: messages.find((message) => message.messageId === `confirmed-${number}@cloudbeds.com`)?.rawMime ?? '' });
    expect(messages).toHaveLength(90);

    const store = new MemoryMailStore();
    let queued = 0;
    let stored = 0;
    for (const message of messages) {
      const outcome = store.accept(message);
      if (outcome === 'queued') queued += 1;
      else stored += 1;
    }
    expect(queued).toBe(86);
    expect(stored).toBe(4);
    expect(new Set(messages.map((message) => message.messageId)).size).toBe(86);
    for (const message of messages) expect(store.jobs.some((job) => job.messageId === message.messageId)).toBe(true);

    const crashed = await store.claim(3, 1_000);
    expect(crashed).toHaveLength(3);
    expect(store.jobs.filter((job) => job.status === 'PROCESSING')).toHaveLength(3);
    expect(await store.recover(null)).toBe(3);
    expect(store.jobs.some((job) => job.status === 'PROCESSING')).toBe(false);

    const book = new StayBook();
    for (const number of temporary) book.failOnce.add(number);
    let clock = 10_000;
    const totals = await pumpMailQueue({
      store,
      concurrency: 4,
      maxAttempts: 5,
      baseDelayMs: 20,
      now: () => clock,
      stopWhenIdle: true,
      advanceTo: (time) => { clock = time; },
      work: async (job) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        const parsed = await readCloudbedsMessage(Buffer.from(job.rawMime, 'utf8'));
        if (!parsed.reservation) return { terminal: 'SKIPPED', error: 'Not a Cloudbeds reservation.', subject: parsed.subject, fromAddress: parsed.from, receivedAt: parsed.date, noticeAt: parsed.noticeAt };
        const result = await book.import(parsed.reservation, parsed.noticeAt, job.messageId);
        const decided = mailResultForImport({ action: result.action, detail: result.detail, stayId: result.stayId, attempts: job.attempts, maxAttempts: 5 });
        if (decided.retry) throw new TemporaryMailError(decided.error);
        return {
          terminal: decided.terminal,
          error: decided.error,
          subject: parsed.subject,
          fromAddress: parsed.from,
          receivedAt: parsed.date,
          noticeAt: parsed.noticeAt,
          noticeKind: parsed.reservation.kind.toUpperCase(),
          confirmationNumber: parsed.reservation.confirmationNumber,
          source: parsed.reservation.source,
          stayId: decided.stayId,
        };
      },
    });

    expect(totals.maxInFlight).toBe(4);
    expect(store.jobs.some((job) => job.status === 'PENDING' || job.status === 'PROCESSING')).toBe(false);
    expect(store.jobs).toHaveLength(86);
    expect(store.jobs.filter((job) => job.status === 'PROCESSED')).toHaveLength(74);
    expect(store.jobs.filter((job) => job.status === 'DUPLICATE')).toHaveLength(8);
    expect(store.jobs.filter((job) => job.status === 'SKIPPED')).toHaveLength(4);
    expect(store.jobs.filter((job) => job.status === 'FAILED')).toHaveLength(0);
    expect(book.stays).toHaveLength(56);
    expect(new Set(book.stays.map((stay) => stay.confirmationNumber)).size).toBe(56);

    for (const number of [...modified, ...early]) {
      const stays = book.stays.filter((stay) => stay.confirmationNumber === number);
      expect(stays).toHaveLength(1);
      expect(stays[0].primaryGuestName).toBe(`Guest ${number} Updated`);
      expect(stays[0].grandTotal).toBe('1200.00');
      expect(stays[0].amountPaid).toBe('0.00');
      expect(stays[0].depositAmount).toBe('900.00');
      expect(stays[0].events).toEqual(['created', 'modified']);
      expect(stays[0].cancelledAt).toBeNull();
    }
    for (const number of cancelled) {
      const stays = book.stays.filter((stay) => stay.confirmationNumber === number);
      expect(stays).toHaveLength(1);
      expect(stays[0].primaryGuestName).toBe(`Guest ${number}`);
      expect(stays[0].amountPaid).toBe('0.00');
      expect(stays[0].depositAmount).toBe('900.00');
      expect(stays[0].cancelledAt).toBeTruthy();
      expect(stays[0].events).toEqual(['created', 'cancelled']);
      expect(stays[0].guestNotes).toContain('Imported from a forwarded Cloudbeds email.');
      expect(stays[0].guestNotes).toContain('Cancelled from');
    }
    for (const number of duplicated) expect(book.stays.filter((stay) => stay.confirmationNumber === number)).toHaveLength(1);
    for (const number of temporary) {
      expect(book.stays.filter((stay) => stay.confirmationNumber === number)).toHaveLength(1);
      expect(book.calls.get(number)).toBe(2);
    }
    for (const number of [...nested, ...extra]) expect(book.stays.filter((stay) => stay.confirmationNumber === number)).toHaveLength(1);
    expect(store.jobs.filter((job) => job.messageId.startsWith('malformed-')).every((job) => job.status === 'SKIPPED')).toBe(true);
    expect(store.jobs.filter((job) => job.messageId.startsWith('nested-')).every((job) => job.status === 'PROCESSED' && job.confirmationNumber)).toBe(true);
  }, 20_000);
});
