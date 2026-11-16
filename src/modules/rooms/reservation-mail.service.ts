import { ConflictException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { ImapFlow } from 'imapflow';
import { InboundEmailStatus } from 'prisma/generated/prisma/enums';
import { PrismaService } from '../../utils/prisma/prisma.service';
import { extractCloudbedsNotices, importOutcome, type ExtractedCloudbedsNotice } from './cloudbeds-email';
import { RoomsService } from './rooms.service';
import { syncRole } from '../sync/sync-tables';
import { beginExclusiveSync, inboundMessageKey, isTemporaryMailError, mailConcurrency, mailLookback, mailMaxAttempts, mailResultForImport, mailRetryBaseMs, mailStaleMs, pumpMailQueue, renderImportAttempt, TemporaryMailError, type ImportAttemptStage, type MailQueueStore, type MailWorkResult, type QueuedMail } from './reservation-mail.queue';

const MAX_MESSAGE_BYTES = 3_000_000;
const TERMINAL: InboundEmailStatus[] = [InboundEmailStatus.PROCESSED, InboundEmailStatus.DUPLICATE, InboundEmailStatus.SKIPPED, InboundEmailStatus.FAILED];

@Injectable()
export class ReservationMailService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReservationMailService.name);
  private stopping = false;
  private connected = false;
  private lastError: string | null = null;
  private delayMs = 5_000;
  private client: ImapFlow | null = null;
  private pumpStarted = false;
  private pump: Promise<void> | null = null;
  private syncState = { running: false };
  private activeRunId: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly queue: MailQueueStore;

  constructor(private readonly prisma: PrismaService, private readonly rooms: RoomsService) {
    this.queue = {
      claim: (limit, now) => this.claimJobs(limit, now),
      save: (job) => this.saveJob(job),
      recover: (staleBefore) => this.recoverJobs(staleBefore),
      readyCount: (now) => this.readyCount(now),
      soonestRetry: (now) => this.soonestRetry(now),
    };
  }

  onModuleInit() {
    // The hosted server only mirrors the laptop; importing mail there would write rows the next sync overwrites.
    if (syncRole() === 'server') return;
    this.ensurePump();
    this.schedule();
    if (!this.configured()) {
      this.logger.warn('Reservation email import is waiting for IMAP_HOST, IMAP_USER, and IMAP_PASSWORD.');
      return;
    }
    void this.loop();
  }

  async onModuleDestroy() {
    this.stopping = true;
    this.connected = false;
    if (this.timer) clearInterval(this.timer);
    await Promise.race([this.pump?.catch(() => undefined), this.sleep(5_000)]);
    await this.client?.logout().catch(() => undefined);
  }

  configured() {
    return Boolean(this.env('IMAP_HOST') && this.env('IMAP_USER') && this.env('IMAP_PASSWORD'));
  }

  async status() {
    const [imports, pending, processing, failed] = await Promise.all([
      this.prisma.inboundEmail.findMany({
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { id: true, messageId: true, mailbox: true, uid: true, subject: true, fromAddress: true, receivedAt: true, status: true, error: true, outcome: true, confirmationNumber: true, source: true, noticeKind: true, noticeAt: true, attempts: true, nextAttemptAt: true, stayId: true, createdAt: true, processedAt: true },
      }),
      this.prisma.inboundEmail.count({ where: { status: InboundEmailStatus.PENDING } }),
      this.prisma.inboundEmail.count({ where: { status: InboundEmailStatus.PROCESSING } }),
      this.prisma.inboundEmail.count({ where: { status: InboundEmailStatus.FAILED } }),
    ]);
    return {
      configured: this.configured(),
      connected: this.connected,
      mailbox: this.env('IMAP_MAILBOX') || 'INBOX',
      concurrency: mailConcurrency(this.env('MAIL_CONCURRENCY')),
      pending,
      processing,
      failed,
      lastError: this.lastError,
      imports,
    };
  }

  async detail(id: string) {
    const message = await this.prisma.inboundEmail.findUnique({ where: { id } });
    if (!message) throw new NotFoundException('Imported email not found');
    return message;
  }

  async retry(id: string) {
    const message = await this.prisma.inboundEmail.findUnique({ where: { id }, select: { id: true, status: true } });
    if (!message) throw new NotFoundException('Imported email not found');
    if (message.status !== InboundEmailStatus.FAILED && message.status !== InboundEmailStatus.SKIPPED) {
      throw new ConflictException('Only a failed or skipped reservation email can be retried.');
    }
    await this.prisma.inboundEmail.update({
      where: { id },
      data: { status: InboundEmailStatus.PENDING, attempts: 0, nextAttemptAt: null, error: null, processedAt: null },
    });
    this.ensurePump();
    return this.detail(id);
  }

  async poll() {
    return this.synchronize('MANUAL');
  }

  async runs() {
    const hours = boundedHours(this.env('CLOUDBEDS_SYNC_INTERVAL_HOURS'));
    const latest = await this.prisma.emailSyncRun.findFirst({ orderBy: { startedAt: 'desc' } });
    return {
      intervalHours: hours,
      enabled: this.env('CLOUDBEDS_SYNC_ENABLED') !== 'false',
      sender: this.sender(),
      nextAt: latest?.startedAt ? new Date(latest.startedAt.getTime() + hours * 60 * 60 * 1000) : null,
      runs: await this.prisma.emailSyncRun.findMany({ orderBy: { startedAt: 'desc' }, take: 30 }),
    };
  }

  async history(query: { messageId?: string; confirmation?: string; cloudbedsId?: string; guest?: string; kind?: string; status?: string; from?: string; to?: string }) {
    const status = ['PROCESSED', 'DUPLICATE', 'FAILED', 'SKIPPED', 'PENDING', 'PROCESSING'].includes(query.status ?? '') ? query.status as InboundEmailStatus : undefined;
    return this.prisma.inboundEmail.findMany({
      where: {
        ...(query.messageId ? { messageId: { contains: query.messageId } } : {}),
        ...(query.confirmation ? { confirmationNumber: { contains: query.confirmation } } : {}),
        ...(query.cloudbedsId ? { cloudbedsReservationId: { contains: query.cloudbedsId } } : {}),
        ...(query.guest ? { guestName: { contains: query.guest, mode: 'insensitive' } } : {}),
        ...(query.kind ? { noticeKind: query.kind } : {}),
        ...(status ? { status } : {}),
        ...(query.from || query.to ? { createdAt: { ...(query.from ? { gte: new Date(`${query.from}T00:00:00`) } : {}), ...(query.to ? { lte: new Date(`${query.to}T23:59:59`) } : {}) } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { id: true, messageId: true, subject: true, fromAddress: true, receivedAt: true, status: true, error: true, outcome: true, confirmationNumber: true, cloudbedsReservationId: true, guestName: true, source: true, noticeKind: true, noticeAt: true, stayId: true, parentMessageId: true, createdAt: true, processedAt: true },
    });
  }

  schedule() {
    if (this.timer) clearInterval(this.timer);
    if (this.env('CLOUDBEDS_SYNC_ENABLED') === 'false') return;
    const hours = boundedHours(this.env('CLOUDBEDS_SYNC_INTERVAL_HOURS'));
    this.timer = setInterval(() => { void this.synchronize('SCHEDULED').catch((error: unknown) => this.logger.warn(error instanceof Error ? error.message : 'Scheduled Cloudbeds sync failed')); }, hours * 60 * 60 * 1000);
  }

  async synchronize(trigger: 'MANUAL' | 'SCHEDULED') {
    if (!this.configured()) throw new ServiceUnavailableException('Set IMAP_HOST, IMAP_USER, and IMAP_PASSWORD to the existing mailbox before importing reservations.');
    if (!beginExclusiveSync(this.syncState)) return { status: 'RUNNING' as const, alreadyRunning: true };
    this.ensurePump();
    const run = await this.prisma.emailSyncRun.create({ data: { trigger, status: 'RUNNING' } });
    this.activeRunId = run.id;
    try {
      const client = this.client?.usable ? this.client : null;
      const summary = client ? await this.ingestAndSettle(client) : await this.connectAndIngest();
      const outcomes = summary.ids?.length ? await this.prisma.inboundEmail.groupBy({ by: ['outcome'], where: { id: { in: summary.ids } }, _count: { _all: true } }) : [];
      const outcomeCount = (name: string) => outcomes.find((row) => row.outcome === name)?._count._all ?? 0;
      const status = summary.failed > 0 && summary.processed + summary.duplicate + summary.skipped > 0 ? 'PARTIAL_SUCCESS' : summary.failed > 0 && summary.queued === 0 ? 'FAILED' : summary.failed > 0 ? 'PARTIAL_SUCCESS' : 'SUCCESS';
      const saved = await this.prisma.emailSyncRun.update({
        where: { id: run.id },
        data: {
          status,
          finishedAt: new Date(),
          imapConnected: true,
          scanned: summary.scanned,
          discovered: summary.queued + summary.alreadyStored,
          nested: summary.queued,
          duplicates: summary.alreadyStored + outcomeCount('DUPLICATE'),
          skipped: summary.skipped,
          unmatched: outcomeCount('UNMATCHED'),
          failed: summary.failed + summary.unreadable,
          lastUid: summary.lastUid,
          imported: outcomeCount('IMPORTED'),
          updated: outcomeCount('UPDATED'),
          canceled: outcomeCount('CANCELED'),
          payments: outcomeCount('PAYMENT_NOTIFICATION'),
        },
      });
      return { ...saved, alreadyRunning: false, ...summary };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Cloudbeds synchronization failed';
      this.logger.error(`Cloudbeds sync ${run.id} failed: ${message}`, error instanceof Error ? error.stack : undefined);
      await this.prisma.emailSyncRun.update({ where: { id: run.id }, data: { status: 'FAILED', finishedAt: new Date(), error: message } }).catch(() => undefined);
      throw error;
    } finally {
      this.activeRunId = null;
      this.syncState.running = false;
    }
  }

  async backfill(options?: { wait?: boolean }) {
    if (!this.configured()) throw new ServiceUnavailableException('Set IMAP_HOST, IMAP_USER, and IMAP_PASSWORD to the existing mailbox before importing reservations.');
    if (!beginExclusiveSync(this.syncState)) return { status: 'RUNNING' as const, alreadyRunning: true };
    this.ensurePump();
    await this.prisma.emailSyncRun.updateMany({ where: { status: 'RUNNING' }, data: { status: 'FAILED', finishedAt: new Date(), error: 'Stopped before it finished.' } });
    const run = await this.prisma.emailSyncRun.create({ data: { trigger: 'BACKFILL', status: 'RUNNING' } });
    this.activeRunId = run.id;
    const work = this.finishBackfill(run.id);
    if (options?.wait) return work;
    void work.catch((error: unknown) => this.logger.error(error instanceof Error ? error.message : 'Historical Cloudbeds import failed'));
    return { ...run, alreadyRunning: false };
  }

  private async finishBackfill(runId: string) {
    const run = { id: runId };
    const client = this.connection();
    try {
      await client.connect();
      await client.mailboxOpen(this.mailbox());
      const mailbox = this.mailbox();
      const knownRows = await this.prisma.inboundEmail.findMany({ select: { messageId: true } });
      const known = new Set(knownRows.map((row) => row.messageId));
      const ids: string[] = [];
      let scanned = 0;
      let nested = 0;
      let attachments = 0;
      let parts = 0;
      let maxDepth = 0;
      let duplicates = 0;
      let failed = 0;
      let parents = 0;
      for await (const message of client.fetch('1:*', { uid: true, source: true, envelope: true }, { uid: true })) {
        scanned += 1;
        parents += 1;
        if (!message.source?.length) {
          failed += 1;
          continue;
        }
        try {
          const source = message.source.length > MAX_MESSAGE_BYTES ? message.source.subarray(0, MAX_MESSAGE_BYTES) : message.source;
          const extracted = await extractCloudbedsNotices(source);
          nested += extracted.notices.length;
          attachments += extracted.attachments;
          parts += extracted.parts;
          maxDepth = Math.max(maxDepth, extracted.maxDepth);
          failed += extracted.failedAttachments;
          const parentId = inboundMessageKey(message.envelope?.messageId, source);
          const sender = this.sender();
          for (const notice of extracted.notices) {
            const from = (notice.from ?? '').trim().toLowerCase();
            if (from !== sender) continue;
            const messageId = inboundMessageKey(notice.messageId, notice.raw);
            if (known.has(messageId)) {
              duplicates += 1;
              continue;
            }
            known.add(messageId);
            try {
              const created = await this.prisma.inboundEmail.create({
                data: {
                  messageId,
                  mailbox,
                  rawMime: notice.raw.toString('utf8'),
                  status: InboundEmailStatus.PENDING,
                  attempts: 0,
                  subject: notice.subject?.slice(0, 500) ?? null,
                  fromAddress: notice.from,
                  receivedAt: notice.date,
                  noticeAt: notice.noticeAt,
                  noticeKind: notice.reservation?.kind.toUpperCase() ?? (notice.kind === 'payment' ? 'PAYMENT' : notice.kind === 'unknown' ? 'UNKNOWN' : null),
                  confirmationNumber: notice.reservation?.confirmationNumber ?? null,
                  source: notice.reservation?.source ?? null,
                  guestName: notice.reservation?.guestName ?? null,
                  cloudbedsReservationId: notice.reservation?.cloudbedsReservationId ?? null,
                  parentMessageId: parentId === messageId ? null : parentId,
                  nestingDepth: notice.nestingDepth,
                  attachmentFilename: notice.attachmentFilename?.slice(0, 300) ?? null,
                  syncRunId: run.id,
                  createdAt: notice.noticeAt ?? new Date('2100-01-01T00:00:00Z'),
                },
                select: { id: true },
              });
              ids.push(created.id);
            } catch (error) {
              if (typeof error === 'object' && error && 'code' in error && (error as { code?: string }).code === 'P2002') duplicates += 1;
              else {
                failed += 1;
                this.logger.warn(`Historical notice could not be queued: ${error instanceof Error ? error.message : 'unknown error'}`);
              }
            }
          }
        } catch (error) {
          failed += 1;
          this.logger.warn(`Historical mailbox message could not be read: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
        if (scanned % 25 === 0) {
          await this.prisma.emailSyncRun.update({ where: { id: run.id }, data: { scanned, nested, attachments, parts, maxDepth, duplicates, failed, uniqueEmails: ids.length, imapConnected: true } });
        }
      }
      const deadline = Date.now() + 15 * 60 * 1000;
      while (ids.length && Date.now() < deadline) {
        const open = await this.prisma.inboundEmail.count({ where: { id: { in: ids }, status: { in: [InboundEmailStatus.PENDING, InboundEmailStatus.PROCESSING] } } });
        if (open === 0) break;
        await this.sleep(250);
      }
      const summary = await this.summarize(ids);
      const outcomes = ids.length ? await this.prisma.inboundEmail.groupBy({ by: ['outcome'], where: { id: { in: ids } }, _count: { _all: true } }) : [];
      const outcomeCount = (name: string) => outcomes.find((row) => row.outcome === name)?._count._all ?? 0;
      const kindRows = ids.length ? await this.prisma.inboundEmail.groupBy({ by: ['noticeKind'], where: { id: { in: ids } }, _count: { _all: true } }) : [];
      const kindCount = (name: string) => kindRows.find((row) => row.noticeKind === name)?._count._all ?? 0;
      const status = failed > 0 || summary.failed > 0 ? 'PARTIAL_SUCCESS' : 'SUCCESS';
      const saved = await this.prisma.emailSyncRun.update({
        where: { id: run.id },
        data: {
          status: summary.failed > 0 && outcomeCount('IMPORTED') + outcomeCount('UPDATED') + outcomeCount('CANCELED') === 0 && ids.length === 0 ? 'FAILED' : status,
          finishedAt: new Date(),
          imapConnected: true,
          scanned,
          discovered: parents,
          nested,
          duplicates,
          confirmed: kindCount('CONFIRMED'),
          modified: kindCount('MODIFIED'),
          cancelled: kindCount('CANCELLED'),
          payments: outcomeCount('PAYMENT_NOTIFICATION'),
          imported: outcomeCount('IMPORTED'),
          updated: outcomeCount('UPDATED'),
          canceled: outcomeCount('CANCELED'),
          skipped: summary.skipped,
          unmatched: outcomeCount('UNMATCHED') + outcomeCount('NEEDS_REVIEW'),
          failed: failed + summary.failed,
          parts,
          attachments,
          maxDepth,
          uniqueEmails: ids.length,
          processedAttachments: summary.processed + summary.duplicate + summary.skipped,
          failedAttachments: summary.failed,
          unprocessedAttachments: summary.pending,
        },
      });
      return { ...saved, alreadyRunning: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Historical Cloudbeds import failed';
      this.logger.error(`Cloudbeds backfill ${run.id} failed: ${message}`, error instanceof Error ? error.stack : undefined);
      await this.prisma.emailSyncRun.update({ where: { id: run.id }, data: { status: 'FAILED', finishedAt: new Date(), error: message } }).catch(() => undefined);
      throw error;
    } finally {
      this.activeRunId = null;
      this.syncState.running = false;
      await client.logout().catch(() => client.close());
    }
  }

  private async connectAndIngest() {
    const client = this.connection();
    await client.connect();
    try {
      await client.mailboxOpen(this.mailbox());
      return await this.ingestAndSettle(client);
    } finally {
      await client.logout().catch(() => client.close());
    }
  }

  private ensurePump() {
    if (this.pumpStarted) return;
    this.pumpStarted = true;
    this.pump = (async () => {
      await this.recoverJobs(null).catch((error: unknown) => {
        this.lastError = error instanceof Error ? error.message : 'Could not recover reservation emails';
        this.logger.warn(this.lastError);
      });
      await pumpMailQueue({
        store: this.queue,
        concurrency: mailConcurrency(this.env('MAIL_CONCURRENCY')),
        maxAttempts: mailMaxAttempts(this.env('MAIL_MAX_ATTEMPTS')),
        baseDelayMs: mailRetryBaseMs(this.env('MAIL_RETRY_BASE_MS')),
        now: () => Date.now(),
        work: (job) => this.processJob(job),
        shouldStop: () => this.stopping,
        onIdle: async () => {
          await this.recoverJobs(Date.now() - mailStaleMs(this.env('MAIL_STALE_MS'))).catch(() => undefined);
          await this.sleep(300);
        },
      });
    })();
  }

  private async loop() {
    while (!this.stopping) {
      try {
        await this.watch();
        this.delayMs = 5_000;
      } catch (error) {
        this.connected = false;
        this.lastError = error instanceof Error ? error.message : 'IMAP connection interrupted';
        this.logger.warn(`IMAP connection interrupted. Reconnecting in ${this.delayMs / 1000}s.`);
        await this.sleep(this.delayMs);
        this.delayMs = Math.min(this.delayMs * 2, 60_000);
      }
    }
  }

  private async watch() {
    const client = this.connection();
    this.client = client;
    client.on('error', (error: Error) => {
      this.lastError = error.message;
      this.logger.warn(`IMAP connection interrupted: ${error.message}`);
    });
    await client.connect();
    this.connected = true;
    this.lastError = null;
    await client.mailboxOpen(this.mailbox());
    if (beginExclusiveSync(this.syncState)) {
      try { await this.ingest(client); } finally { this.syncState.running = false; }
    }
    await new Promise<void>((resolve) => {
      const finish = () => resolve();
      client.on('close', finish);
      client.on('exists', () => {
        if (!beginExclusiveSync(this.syncState)) return;
        void this.ingest(client).catch((error: unknown) => { this.lastError = error instanceof Error ? error.message : 'Could not read new mail'; }).finally(() => { this.syncState.running = false; });
      });
    });
    this.connected = false;
    if (this.client === client) this.client = null;
  }

  private async ingestAndSettle(client: ImapFlow) {
    const queued = await this.ingest(client);
    await this.waitUntilSettled(queued.ids);
    const summary = await this.summarize(queued.ids);
    return { scanned: queued.scanned, queued: queued.queued, alreadyStored: queued.alreadyStored, unreadable: queued.unreadable, ids: queued.ids, lastUid: queued.lastUid, ...summary };
  }

  private async ingest(client: ImapFlow) {
    const mailbox = this.mailbox();
    const unseen = await client.search({ seen: false });
    const status = await client.status(mailbox, { uidNext: true });
    const checkpoint = await this.prisma.emailSyncRun.findFirst({
      where: { lastUid: { not: null }, status: { in: ['SUCCESS', 'PARTIAL_SUCCESS'] } },
      orderBy: { startedAt: 'desc' },
      select: { lastUid: true },
    });
    const overlap = mailLookback(this.env('CLOUDBEDS_SYNC_OVERLAP') || this.env('MAIL_LOOKBACK'));
    const recentFrom = checkpoint?.lastUid ? Math.max(1, checkpoint.lastUid - overlap) : Math.max(1, Number(status.uidNext ?? 1) - overlap);
    const recent = await client.search({ uid: `${recentFrom}:*` });
    const uids = [...new Set([...(unseen || []), ...(recent || [])])].sort((left, right) => left - right);
    const ids: string[] = [];
    let queued = 0;
    let alreadyStored = 0;
    let unreadable = 0;
    for (const uid of uids) {
      try {
        const outcome = await this.enqueueUid(client, mailbox, uid);
        if (outcome.kind === 'queued') {
          queued += 1;
          ids.push(outcome.id);
        } else if (outcome.kind === 'exists') alreadyStored += 1;
        else unreadable += 1;
      } catch (error) {
        unreadable += 1;
        this.lastError = error instanceof Error ? error.message : 'Could not queue a reservation email';
        this.logger.warn(`Could not queue mailbox uid ${uid}: ${this.lastError}`);
      }
    }
    if (queued) this.logger.log(`Queued ${queued} reservation ${queued === 1 ? 'email' : 'emails'} for import.`);
    return { scanned: uids.length, queued, alreadyStored, unreadable, ids, lastUid: uids.at(-1) ?? checkpoint?.lastUid ?? null };
  }

  private async enqueueUid(client: ImapFlow, mailbox: string, uid: number) {
    const message = await client.fetchOne(String(uid), { uid: true, source: true, envelope: true }, { uid: true });
    if (!message || !message.source) {
      this.logger.warn(`Mailbox uid ${uid} had no message source and was left unread.`);
      return { kind: 'unreadable' as const };
    }
    const truncated = message.source.length > MAX_MESSAGE_BYTES;
    const source = truncated ? message.source.subarray(0, MAX_MESSAGE_BYTES) : message.source;
    const messageId = inboundMessageKey(message.envelope?.messageId, source);
    const existing = await this.prisma.inboundEmail.findUnique({ where: { messageId }, select: { id: true, status: true } });
    if (existing) {
      if (existing.status !== InboundEmailStatus.PENDING && existing.status !== InboundEmailStatus.PROCESSING) await this.markSeen(client, uid);
      return { kind: 'exists' as const };
    }
    try {
      const created = await this.prisma.inboundEmail.create({
        data: {
          messageId,
          mailbox,
          uid,
          rawMime: source.toString('utf8'),
          status: InboundEmailStatus.PENDING,
          attempts: 0,
          subject: message.envelope?.subject?.slice(0, 500) ?? null,
          fromAddress: message.envelope?.from?.[0]?.address ?? null,
          receivedAt: message.envelope?.date ?? null,
          error: truncated ? 'Message was truncated.' : null,
          syncRunId: this.activeRunId,
        },
        select: { id: true },
      });
      return { kind: 'queued' as const, id: created.id };
    } catch (error) {
      if (typeof error === 'object' && error && 'code' in error && (error as { code?: string }).code === 'P2002') return { kind: 'exists' as const };
      throw error;
    }
  }

  private async processJob(job: QueuedMail) {
    const stages: ImportAttemptStage[] = [];
    const note = (stage: string, status: ImportAttemptStage['status'], detail: string) => { stages.push({ stage, status, detail }); };
    const finish = (result: string, extra: MailWorkResult) => {
      const attemptLog = { stages, result };
      const text = renderImportAttempt({ runId: this.activeRunId, messageId: job.messageId, subject: (extra.subject as string | null) ?? job.subject, from: (extra.fromAddress as string | null) ?? job.fromAddress, noticeAt: (extra.noticeAt as Date | null) ?? null, stages, result });
      if (String(result).includes('FAIL')) this.logger.error(text);
      else this.logger.log(text);
      return { ...extra, attemptLog };
    };
    let extracted;
    try {
      extracted = await extractCloudbedsNotices(Buffer.from(job.rawMime, 'utf8'));
      note('EMAIL DISCOVERY', 'SUCCESS', `Parts ${extracted.parts}, attachments ${extracted.attachments}, depth ${extracted.maxDepth}, notices ${extracted.notices.length}.`);
      note('MIME EXTRACTION', extracted.failedAttachments ? 'FAILED' : 'SUCCESS', extracted.failedAttachments ? `${extracted.failedAttachments} attachment(s) could not be parsed. The rest continued.` : 'HTML and text bodies were decoded.');
      note('DEDUPLICATION', 'SUCCESS', extracted.duplicates ? `${extracted.duplicates} duplicate part(s) skipped.` : 'Message is not a duplicate.');
    } catch (error) {
      if (isTemporaryMailError(error)) throw error;
      note('MIME EXTRACTION', 'FAILED', error instanceof Error ? error.message : 'The message could not be read.');
      return finish('FAILED', { terminal: 'FAILED' as const, retryable: false, outcome: 'FAILED', error: error instanceof Error ? error.message : 'The message could not be read.' });
    }
    const sender = this.sender();
    const fromSender = (address: string | null) => (address ?? '').trim().toLowerCase() === sender;
    const reservations = extracted.notices.filter((notice) => notice.reservation && fromSender(notice.from));
    const payments = extracted.notices.filter((notice) => notice.kind === 'payment' && !notice.reservation && fromSender(notice.from));
    const actionable = extracted.notices.filter((notice) => fromSender(notice.from) && (notice.reservation || notice.kind === 'payment' || notice.kind === 'unknown'));
    const ownsNotice = actionable.some((notice) => this.sameStoredMessage(job.messageId, notice));
    if (actionable.length > 1 && !ownsNotice) {
      for (const notice of actionable) await this.enqueueExtracted(job.mailbox, notice, job.messageId);
      note('EVENT CLASSIFICATION', 'SUCCESS', `Queued ${actionable.length} nested Cloudbeds messages. The wrapper is not a reservation.`);
      return finish('SKIPPED', {
        terminal: 'SKIPPED' as const,
        outcome: null,
        error: `Queued ${actionable.length} nested emails.`,
        subject: extracted.outer.subject,
        fromAddress: extracted.outer.from,
        receivedAt: extracted.outer.date,
        noticeAt: null,
        noticeKind: null,
        confirmationNumber: null,
        source: null,
        stayId: null,
      });
    }
    const chosen = (ownsNotice ? actionable.find((notice) => this.sameStoredMessage(job.messageId, notice)) : null) ?? reservations[0] ?? payments[0] ?? extracted.notices[0];
    if (ownsNotice) {
      for (const notice of actionable) {
        if (!chosen || notice === chosen || this.sameStoredMessage(job.messageId, notice)) continue;
        await this.enqueueExtracted(job.mailbox, notice, job.messageId);
      }
    }
    const described = {
      subject: chosen?.subject ?? extracted.outer.subject,
      fromAddress: chosen?.from ?? extracted.outer.from,
      receivedAt: extracted.outer.date,
      noticeAt: chosen?.noticeAt ?? null,
      noticeKind: chosen?.reservation?.kind.toUpperCase() ?? (chosen?.kind === 'payment' ? 'PAYMENT' : chosen?.kind === 'unknown' ? 'UNKNOWN' : null),
      confirmationNumber: chosen?.reservation?.confirmationNumber ?? null,
      source: chosen?.reservation?.source ?? null,
      guestName: chosen?.reservation?.guestName ?? null,
      cloudbedsReservationId: chosen?.reservation?.cloudbedsReservationId ?? null,
      stayId: null as string | null,
    };
    note('EVENT CLASSIFICATION', 'SUCCESS', `Event Type: ${described.noticeKind ?? 'NONE'}`);
    if (chosen?.reservation && !fromSender(chosen.from)) {
      note('EVENT CLASSIFICATION', 'SKIPPED', `Sender ${chosen.from ?? 'unknown'} is not ${sender}.`);
      return finish('SKIPPED', { terminal: 'SKIPPED' as const, outcome: 'NEEDS_REVIEW', error: `Sender is not ${sender}.`, ...described });
    }
    if (!chosen?.reservation) {
      if (chosen?.kind === 'payment') {
        note('RESERVATION PARSING', 'SUCCESS', 'Payment notification. No reservation was created.');
        return finish('PAYMENT_NOTIFICATION', { terminal: 'SKIPPED' as const, outcome: 'PAYMENT_NOTIFICATION', error: null, ...described, noticeKind: 'PAYMENT' });
      }
      const truncated = job.error?.includes('truncated');
      const blob = `${described.subject ?? ''} ${described.fromAddress ?? ''}`;
      const cloudbeds = /cloudbeds|reservation|booking\.com/i.test(blob);
      note('RESERVATION PARSING', cloudbeds ? 'FAILED' : 'SKIPPED', truncated ? 'Message was truncated.' : 'No reservation table was found.');
      return finish(cloudbeds ? 'NEEDS_REVIEW' : 'SKIPPED', {
        terminal: 'SKIPPED' as const,
        outcome: cloudbeds ? 'NEEDS_REVIEW' : null,
        error: truncated ? 'Message was truncated. It is not a Cloudbeds reservation.' : cloudbeds ? 'Cloudbeds notice was not a reservation.' : 'Not a Cloudbeds reservation.',
        ...described,
      });
    }
    note('RESERVATION PARSING', 'SUCCESS', `Guest: ${chosen.reservation.guestName}. Confirmation: ${chosen.reservation.confirmationNumber}. Cloudbeds ID: ${chosen.reservation.cloudbedsReservationId ?? 'none'}. Check-in: ${chosen.reservation.checkIn.toISOString().slice(0, 10)}. Check-out: ${chosen.reservation.checkOut.toISOString().slice(0, 10)}. Room type: ${chosen.reservation.roomType ?? 'none'}.`);
    try {
      const result = await this.rooms.importEmailReservation(chosen.reservation, { noticeAt: chosen.noticeAt, reference: job.messageId });
      const decided = mailResultForImport({ action: result.action, detail: result.detail, stayId: result.stayId, attempts: job.attempts, maxAttempts: mailMaxAttempts(this.env('MAIL_MAX_ATTEMPTS')) });
      if (decided.retry) throw new TemporaryMailError(decided.error);
      const match = 'match' in result ? result.match : undefined;
      note('RESERVATION MATCHING', match?.found || result.action === 'created' ? 'SUCCESS' : 'FAILED', `Incoming Cloudbeds ID: ${match?.cloudbedsReservationId ?? 'none'}. Incoming Confirmation Number: ${match?.confirmationNumber ?? chosen.reservation.confirmationNumber}. Incoming Source Reservation ID: ${match?.sourceReservationId ?? 'none'}. Matched Existing Reservation ID: ${match?.stayId ?? result.stayId ?? 'none'}. Matching Strategy: ${match?.strategy ?? 'none'}. Existing Reservation Found: ${match?.found ? 'YES' : 'NO'}. Planned Operation: ${match?.operation ?? result.action}.`);
      const changes = 'changes' in result ? result.changes : undefined;
      if (changes) note('CHANGE DETECTION', 'SUCCESS', `Check-in Changed: ${changes.checkIn ? 'YES' : 'NO'}. Check-out Changed: ${changes.checkOut ? 'YES' : 'NO'}. Room Type Changed: ${changes.roomType ? 'YES' : 'NO'}. Price Changed: ${changes.price ? 'YES' : 'NO'}.`);
      note('DATABASE UPDATE', 'SUCCESS', `Operation: ${match?.operation ?? result.action}. Existing Reservation ID: ${result.stayId ?? 'none'}. New Reservation Created: ${result.action === 'created' ? 'YES' : 'NO'}.`);
      note('ROOM ASSIGNMENT', result.detail?.includes('needs review') ? 'FAILED' : 'SUCCESS', result.detail ?? 'Room assignment used the existing room rules.');
      note('CALENDAR SYNCHRONIZATION', 'SUCCESS', result.action === 'modified' ? 'Old dates follow the updated stay. The Room Calendar reads those dates.' : 'The Room Calendar reads this stay.');
      const outcome = importOutcome(result.action, result.detail);
      return finish(outcome, { terminal: decided.terminal, outcome, error: decided.error, ...described, stayId: decided.stayId, noticeKind: chosen.reservation.kind.toUpperCase() });
    } catch (error) {
      if (error instanceof TemporaryMailError || isTemporaryMailError(error)) throw error;
      const message = error instanceof Error ? error.message : 'The reservation could not be created.';
      note('DATABASE UPDATE', 'FAILED', `${error instanceof Error ? error.name : 'Error'}: ${message}. Transaction rolled back: YES. Retry: NO.`);
      this.logger.error(`Cloudbeds import failed for ${job.messageId}`, error instanceof Error ? error.stack : undefined);
      return finish('FAILED', { terminal: 'FAILED' as const, retryable: false, outcome: 'FAILED', error: message, ...described });
    }
  }

  private sameStoredMessage(messageId: string, notice: ExtractedCloudbedsNotice) {
    return inboundMessageKey(notice.messageId, notice.raw) === messageId;
  }

  private async enqueueExtracted(mailbox: string, notice: ExtractedCloudbedsNotice, parentMessageId: string) {
    const messageId = inboundMessageKey(notice.messageId, notice.raw);
    const existing = await this.prisma.inboundEmail.findUnique({ where: { messageId }, select: { id: true } });
    if (existing) return;
    try {
      await this.prisma.inboundEmail.create({
        data: {
          messageId,
          mailbox,
          rawMime: notice.raw.toString('utf8'),
          status: InboundEmailStatus.PENDING,
          attempts: 0,
          subject: notice.subject?.slice(0, 500) ?? null,
          fromAddress: notice.from,
          receivedAt: notice.date,
          noticeAt: notice.noticeAt,
          noticeKind: notice.reservation?.kind.toUpperCase() ?? (notice.kind === 'payment' ? 'PAYMENT' : null),
          confirmationNumber: notice.reservation?.confirmationNumber ?? null,
          source: notice.reservation?.source ?? null,
          guestName: notice.reservation?.guestName ?? null,
          cloudbedsReservationId: notice.reservation?.cloudbedsReservationId ?? null,
          parentMessageId,
          syncRunId: this.activeRunId,
        },
      });
    } catch (error) {
      if (typeof error === 'object' && error && 'code' in error && (error as { code?: string }).code === 'P2002') return;
      throw error;
    }
  }

  private async claimJobs(limit: number, now: number) {
    if (limit <= 0) return [];
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      WITH claimed AS (
        SELECT id
        FROM "InboundEmail"
        WHERE status = 'PENDING'::"InboundEmailStatus"
          AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= CURRENT_TIMESTAMP)
        ORDER BY "createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      UPDATE "InboundEmail" AS email
      SET status = 'PROCESSING'::"InboundEmailStatus",
          "processedAt" = CURRENT_TIMESTAMP
      FROM claimed
      WHERE email.id = claimed.id
      RETURNING email.id
    `;
    if (!rows.length) return [];
    const found = await this.prisma.inboundEmail.findMany({ where: { id: { in: rows.map((row) => row.id) } } });
    return found.map((row) => this.toJob(row, now));
  }

  private toJob(row: {
    id: string;
    messageId: string;
    mailbox: string;
    uid: number | null;
    rawMime: string;
    status: InboundEmailStatus;
    attempts: number;
    nextAttemptAt: Date | null;
    error: string | null;
    subject: string | null;
    fromAddress: string | null;
    receivedAt: Date | null;
    noticeAt: Date | null;
    noticeKind: string | null;
    confirmationNumber: string | null;
    source: string | null;
    stayId: string | null;
    outcome: string | null;
    attemptLog: unknown;
    guestName: string | null;
    cloudbedsReservationId: string | null;
    parentMessageId: string | null;
    nestingDepth: number | null;
    createdAt: Date;
    processedAt: Date | null;
  }, now: number): QueuedMail {
    return {
      id: row.id,
      messageId: row.messageId,
      mailbox: row.mailbox,
      uid: row.uid,
      rawMime: row.rawMime,
      status: row.status as QueuedMail['status'],
      attempts: row.attempts,
      nextAttemptAt: row.nextAttemptAt?.getTime() ?? null,
      claimedAt: row.processedAt?.getTime() ?? now,
      error: row.error,
      subject: row.subject,
      fromAddress: row.fromAddress,
      receivedAt: row.receivedAt,
      noticeAt: row.noticeAt,
      noticeKind: row.noticeKind,
      confirmationNumber: row.confirmationNumber,
      source: row.source,
      stayId: row.stayId,
      outcome: row.outcome,
      attemptLog: row.attemptLog,
      guestName: row.guestName,
      cloudbedsReservationId: row.cloudbedsReservationId,
      parentMessageId: row.parentMessageId,
      nestingDepth: row.nestingDepth,
      createdAt: row.createdAt.getTime(),
    };
  }

  private async saveJob(job: QueuedMail) {
    const terminal = TERMINAL.includes(job.status as InboundEmailStatus);
    await this.prisma.inboundEmail.update({
      where: { id: job.id },
      data: {
        status: job.status as InboundEmailStatus,
        attempts: job.attempts,
        nextAttemptAt: job.nextAttemptAt ? new Date(job.nextAttemptAt) : null,
        error: job.error,
        subject: job.subject?.slice(0, 500) ?? null,
        fromAddress: job.fromAddress,
        receivedAt: job.receivedAt,
        noticeAt: job.noticeAt,
        noticeKind: job.noticeKind,
        confirmationNumber: job.confirmationNumber,
        source: job.source,
        stayId: job.stayId,
        outcome: job.outcome,
        attemptLog: job.attemptLog ?? undefined,
        guestName: job.guestName,
        cloudbedsReservationId: job.cloudbedsReservationId,
        parentMessageId: job.parentMessageId,
        nestingDepth: job.nestingDepth,
        processedAt: terminal ? new Date() : null,
      },
    });
    if (terminal && job.uid != null) await this.markSeen(this.client, job.uid);
  }

  private async recoverJobs(staleBefore: number | null) {
    const result = await this.prisma.inboundEmail.updateMany({
      where: {
        status: InboundEmailStatus.PROCESSING,
        ...(staleBefore == null ? {} : { processedAt: { lt: new Date(staleBefore) } }),
      },
      data: { status: InboundEmailStatus.PENDING, nextAttemptAt: null, processedAt: null },
    });
    if (result.count) this.logger.warn(`Returned ${result.count} interrupted reservation ${result.count === 1 ? 'email' : 'emails'} to the queue.`);
    return result.count;
  }

  private async readyCount(now: number) {
    return this.prisma.inboundEmail.count({
      where: { status: InboundEmailStatus.PENDING, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date(now) } }] },
    });
  }

  private async soonestRetry(now: number) {
    const row = await this.prisma.inboundEmail.findFirst({
      where: { status: InboundEmailStatus.PENDING, nextAttemptAt: { gt: new Date(now) } },
      orderBy: { nextAttemptAt: 'asc' },
      select: { nextAttemptAt: true },
    });
    return row?.nextAttemptAt?.getTime() ?? null;
  }

  private async waitUntilSettled(ids: string[]) {
    const deadline = Date.now() + 120_000;
    while (ids.length && Date.now() < deadline) {
      const open = await this.prisma.inboundEmail.count({
        where: { id: { in: ids }, status: { in: [InboundEmailStatus.PENDING, InboundEmailStatus.PROCESSING] } },
      });
      if (open === 0) return;
      await this.sleep(100);
    }
  }

  private async summarize(ids: string[]) {
    if (!ids.length) return { processed: 0, duplicate: 0, skipped: 0, failed: 0, pending: 0 };
    const rows = await this.prisma.inboundEmail.groupBy({ by: ['status'], where: { id: { in: ids } }, _count: { _all: true } });
    const count = (status: InboundEmailStatus) => rows.find((row) => row.status === status)?._count._all ?? 0;
    return {
      processed: count(InboundEmailStatus.PROCESSED),
      duplicate: count(InboundEmailStatus.DUPLICATE),
      skipped: count(InboundEmailStatus.SKIPPED),
      failed: count(InboundEmailStatus.FAILED),
      pending: count(InboundEmailStatus.PENDING) + count(InboundEmailStatus.PROCESSING),
    };
  }

  private async markSeen(client: ImapFlow | null, uid: number) {
    if (!client?.usable) return;
    await client.messageFlagsAdd({ uid }, ['\\Seen'], { uid: true }).catch(() => undefined);
  }

  private connection() {
    const host = this.env('IMAP_HOST');
    return new ImapFlow({
      host,
      port: Number(this.env('IMAP_PORT') || 993),
      secure: this.env('IMAP_SECURE') !== 'false',
      auth: { user: this.env('IMAP_USER'), pass: this.env('IMAP_PASSWORD') },
      logger: false,
      tls: { servername: host },
    });
  }

  private mailbox() {
    return this.env('IMAP_MAILBOX') || 'INBOX';
  }

  private sender() {
    return (this.env('CLOUDBEDS_SENDER') || 'admin@cloudbeds.com').toLowerCase();
  }

  private env(name: string) {
    const aliases: Record<string, string> = { IMAP_HOST: 'CLOUDBEDS_IMAP_HOST', IMAP_PORT: 'CLOUDBEDS_IMAP_PORT', IMAP_SECURE: 'CLOUDBEDS_IMAP_SECURE', IMAP_USER: 'CLOUDBEDS_IMAP_USER', IMAP_PASSWORD: 'CLOUDBEDS_IMAP_PASSWORD' };
    return process.env[name]?.trim() || process.env[aliases[name] ?? '']?.trim() || '';
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function boundedHours(value: string) {
  const parsed = Number(value || '24');
  if (!Number.isFinite(parsed)) return 24;
  return Math.min(168, Math.max(1, Math.floor(parsed)));
}
