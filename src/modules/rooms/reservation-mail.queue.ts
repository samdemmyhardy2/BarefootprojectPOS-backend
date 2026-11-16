import { createHash } from 'node:crypto';
import { noticeWaitingForStay } from './cloudbeds-email';

/** PROCESSED is the stored completed state. Historical rows already use it. */
export type MailJobState = 'PENDING' | 'PROCESSING' | 'PROCESSED' | 'DUPLICATE' | 'FAILED' | 'SKIPPED';

export type QueuedMail = {
  id: string;
  messageId: string;
  mailbox: string;
  uid: number | null;
  rawMime: string;
  status: MailJobState;
  attempts: number;
  nextAttemptAt: number | null;
  claimedAt: number | null;
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
  attemptLog?: unknown;
  guestName?: string | null;
  cloudbedsReservationId?: string | null;
  parentMessageId?: string | null;
  nestingDepth?: number | null;
  createdAt: number;
};

export type MailWorkResult = {
  terminal: 'PROCESSED' | 'DUPLICATE' | 'SKIPPED' | 'FAILED';
  retryable?: boolean;
  error: string | null;
  subject?: string | null;
  fromAddress?: string | null;
  receivedAt?: Date | null;
  noticeAt?: Date | null;
  noticeKind?: string | null;
  confirmationNumber?: string | null;
  source?: string | null;
  stayId?: string | null;
  outcome?: string | null;
  attemptLog?: unknown;
  guestName?: string | null;
  cloudbedsReservationId?: string | null;
  parentMessageId?: string | null;
  nestingDepth?: number | null;
};

export type MailPumpTotals = {
  processed: number;
  duplicate: number;
  skipped: number;
  failed: number;
  retried: number;
  maxInFlight: number;
};

export interface MailQueueStore {
  claim(limit: number, now: number): Promise<QueuedMail[]>;
  save(job: QueuedMail): Promise<void>;
  /** Move PROCESSING jobs back to PENDING. A null cutoff recovers every PROCESSING job. */
  recover(staleBefore: number | null): Promise<number>;
  readyCount(now: number): Promise<number>;
  soonestRetry(now: number): Promise<number | null>;
}

export class TemporaryMailError extends Error {
  constructor(message = 'Temporary mail processing failure') {
    super(message);
    this.name = 'TemporaryMailError';
  }
}

const TEMPORARY_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2034', '40P01', '40001', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT']);

export function isTemporaryMailError(error: unknown) {
  if (error instanceof TemporaryMailError) return true;
  const code = typeof error === 'object' && error && 'code' in error ? String((error as { code: unknown }).code) : '';
  if (TEMPORARY_CODES.has(code)) return true;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /timeout|ECONNRESET|ECONNREFUSED|deadlock|Connection terminated|temporarily unavailable|database is unavailable/i.test(message);
}

/** Message-ID when the mail has one. Otherwise a stable hash of the raw message. */
export function inboundMessageKey(messageId: string | null | undefined, raw: Buffer | string) {
  const id = messageId?.replace(/\s+/g, ' ').trim();
  if (id) return id.slice(0, 900);
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function boundedMailNumber(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value ?? '');
  const chosen = value?.trim() && Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
  return Math.min(max, Math.max(min, chosen));
}

export function mailConcurrency(value: string | undefined) {
  return boundedMailNumber(value, 3, 1, 5);
}

export function mailMaxAttempts(value: string | undefined) {
  return boundedMailNumber(value, 5, 1, 8);
}

export function mailLookback(value: string | undefined) {
  return boundedMailNumber(value, 200, 90, 5_000);
}

export function mailRetryBaseMs(value: string | undefined) {
  return boundedMailNumber(value, 2_000, 100, 60_000);
}

export function mailStaleMs(value: string | undefined) {
  return boundedMailNumber(value, 10 * 60 * 1000, 1_000, 60 * 60 * 1000);
}

export function mailRetryDelayMs(attempt: number, baseMs: number) {
  const step = Math.max(0, attempt - 1);
  return Math.min(baseMs * 2 ** Math.min(step, 16), 60_000);
}

export type ImportAttemptStage = { stage: string; status: 'SUCCESS' | 'FAILED' | 'SKIPPED'; detail: string };

/** Text log for one email. It never includes the message body or mailbox credentials. */
export function renderImportAttempt(input: { runId: string | null; messageId: string; subject: string | null; from: string | null; noticeAt: Date | null; stages: ImportAttemptStage[]; result: string }) {
  const lines = [
    '========================================================',
    'CLOUDBEDS EMAIL IMPORT ATTEMPT',
    '========================================================',
    `Run ID: ${input.runId ?? 'none'}`,
    `Message-ID: ${input.messageId}`,
    `Subject: ${input.subject ?? ''}`,
    `Original Sender: ${input.from ?? ''}`,
    `Email Date: ${input.noticeAt?.toISOString() ?? ''}`,
    '',
  ];
  input.stages.forEach((stage, index) => {
    lines.push(`[${index + 1}] ${stage.stage}`, `    Status: ${stage.status}`, `    ${stage.detail}`, '');
  });
  lines.push(`FINAL RESULT: ${input.result}`, '========================================================');
  return lines.join('\n');
}

export function beginExclusiveSync(state: { running: boolean }) {
  if (state.running) return false;
  state.running = true;
  return true;
}

export function mailResultForImport(input: {
  action: 'created' | 'modified' | 'cancelled' | 'duplicate' | 'review' | 'stale';
  detail: string | null;
  stayId: string | null;
  attempts: number;
  maxAttempts: number;
}) {
  if (input.action === 'review' && noticeWaitingForStay(input.detail) && input.attempts + 1 < input.maxAttempts) {
    return { retry: true as const, error: input.detail ?? 'Matching reservation is not stored yet.' };
  }
  const terminal = input.action === 'duplicate' ? 'DUPLICATE' as const : input.action === 'review' || input.action === 'stale' ? 'SKIPPED' as const : 'PROCESSED' as const;
  return { retry: false as const, terminal, error: input.detail, stayId: input.stayId };
}

export async function pumpMailQueue(options: {
  store: MailQueueStore;
  concurrency: number;
  maxAttempts: number;
  baseDelayMs: number;
  now: () => number;
  work: (job: QueuedMail) => Promise<MailWorkResult>;
  stopWhenIdle?: boolean;
  shouldStop?: () => boolean;
  onIdle?: () => Promise<void>;
  advanceTo?: (time: number) => void;
}): Promise<MailPumpTotals> {
  const concurrency = Math.min(5, Math.max(1, Math.floor(options.concurrency)));
  const totals: MailPumpTotals = { processed: 0, duplicate: 0, skipped: 0, failed: 0, retried: 0, maxInFlight: 0 };
  let inFlight = 0;
  const pending = new Set<Promise<void>>();

  const finish = (job: QueuedMail, result: MailWorkResult) => {
    const attempts = job.attempts + 1;
    if (result.terminal === 'FAILED' && result.retryable && attempts < options.maxAttempts) {
      job.status = 'PENDING';
      job.attempts = attempts;
      job.nextAttemptAt = options.now() + mailRetryDelayMs(attempts, options.baseDelayMs);
      job.error = result.error;
      job.claimedAt = null;
      totals.retried += 1;
      return;
    }
    job.attempts = attempts;
    job.status = result.terminal;
    job.nextAttemptAt = null;
    job.error = result.error;
    job.claimedAt = null;
    if (result.subject !== undefined) job.subject = result.subject;
    if (result.fromAddress !== undefined) job.fromAddress = result.fromAddress;
    if (result.receivedAt !== undefined) job.receivedAt = result.receivedAt;
    if (result.noticeAt !== undefined) job.noticeAt = result.noticeAt;
    if (result.noticeKind !== undefined) job.noticeKind = result.noticeKind;
    if (result.confirmationNumber !== undefined) job.confirmationNumber = result.confirmationNumber;
    if (result.source !== undefined) job.source = result.source;
    if (result.stayId !== undefined) job.stayId = result.stayId;
    if (result.outcome !== undefined) job.outcome = result.outcome;
    if (result.attemptLog !== undefined) job.attemptLog = result.attemptLog;
    if (result.guestName !== undefined) job.guestName = result.guestName;
    if (result.cloudbedsReservationId !== undefined) job.cloudbedsReservationId = result.cloudbedsReservationId;
    if (result.parentMessageId !== undefined) job.parentMessageId = result.parentMessageId;
    if (result.nestingDepth !== undefined) job.nestingDepth = result.nestingDepth;
    if (result.terminal === 'PROCESSED') totals.processed += 1;
    else if (result.terminal === 'DUPLICATE') totals.duplicate += 1;
    else if (result.terminal === 'SKIPPED') totals.skipped += 1;
    else totals.failed += 1;
  };

  const run = async (job: QueuedMail) => {
    try {
      finish(job, await options.work(job));
    } catch (error) {
      finish(job, {
        terminal: 'FAILED',
        retryable: isTemporaryMailError(error),
        error: error instanceof Error ? error.message : 'The reservation could not be created.',
      });
    }
    await options.store.save(job);
  };

  while (true) {
    if (options.shouldStop?.() && inFlight === 0) break;
    const slots = options.shouldStop?.() ? 0 : concurrency - inFlight;
    const jobs = slots > 0 ? await options.store.claim(slots, options.now()) : [];
    if (!jobs.length) {
      if (inFlight > 0) {
        await Promise.race(pending);
        continue;
      }
      const ready = await options.store.readyCount(options.now());
      if (ready > 0) continue;
      const next = await options.store.soonestRetry(options.now());
      if (next != null && options.advanceTo) {
        options.advanceTo(next);
        continue;
      }
      if (options.stopWhenIdle) break;
      await options.onIdle?.();
      if (options.shouldStop?.()) break;
      continue;
    }
    for (const job of jobs) {
      inFlight += 1;
      totals.maxInFlight = Math.max(totals.maxInFlight, inFlight);
      const task = run(job);
      pending.add(task);
      void task.finally(() => {
        inFlight -= 1;
        pending.delete(task);
      });
    }
  }
  await Promise.all(pending);
  return totals;
}
