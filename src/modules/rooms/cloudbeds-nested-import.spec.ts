import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { extractCloudbedsNotices, importOutcome, planStayNotice, type CloudbedsEmailReservation } from './cloudbeds-email';
import { planImportedRoom, type AssignableRoom } from './room-assignment';

const fixtureDir = ['/home/rizekishimaro/epson-test/email-33-extracted', join(__dirname, 'fixtures', 'email-33-extracted')].find((dir) => existsSync(dir));
const parentMessage = ['/home/rizekishimaro/epson-test/email-33.eml', join(__dirname, 'fixtures', 'email-33.eml')].find((file) => existsSync(file));

const inventory: AssignableRoom[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', 'Family suite'].map((roomNumber) => ({ roomNumber, status: 'AVAILABLE' }));

type MemoryStay = {
  id: string;
  confirmationNumber: string;
  sourceReservationId: string | null;
  guestName: string;
  roomType: string | null;
  roomNumber: string | null;
  checkIn: Date;
  checkOut: Date;
  nights: number | null;
  cancelledAt: Date | null;
  latestNoticeAt: Date | null;
  grandTotal: string | null;
  amountPaid: string | null;
  depositAmount: string | null;
  assignmentReason: string | null;
  needsReview: boolean;
  guestNotes: string | null;
  bookingSource: string;
  cloudbedsReservationId: string | null;
};

function apply(stays: MemoryStay[], reservation: CloudbedsEmailReservation, noticeAt: Date | null) {
  const existing = stays.find((stay) => stay.confirmationNumber === reservation.confirmationNumber) ?? null;
  const decision = planStayNotice({
    existing: existing ? {
      primaryGuestName: existing.guestName,
      guestNotes: existing.guestNotes,
      bookingSource: existing.bookingSource,
      amountPaid: existing.amountPaid,
      cloudbedsReservationId: existing.cloudbedsReservationId,
      cancelledAt: existing.cancelledAt,
      latestNoticeAt: existing.latestNoticeAt,
    } : null,
    reservation,
    noticeAt,
    reference: reservation.confirmationNumber,
  });
  const logged = decision.action === 'create' ? 'created' : decision.action === 'modify' ? 'modified' : decision.action === 'cancel' ? 'cancelled' : decision.action;
  const outcome = importOutcome(logged, decision.detail);
  if (decision.action === 'create') {
    const assignment = planImportedRoom({ roomType: reservation.roomType, inventory, occupiedRoomNumbers: occupied(stays, reservation), currentRoomNumber: null, currentStatus: null });
    stays.push({
      id: `stay-${stays.length + 1}`,
      confirmationNumber: reservation.confirmationNumber,
      sourceReservationId: reservation.sourceReservationId,
      guestName: reservation.guestName,
      roomType: reservation.roomType,
      roomNumber: assignment.roomNumber,
      checkIn: reservation.checkIn,
      checkOut: reservation.checkOut,
      nights: reservation.nights,
      cancelledAt: null,
      latestNoticeAt: noticeAt,
      grandTotal: reservation.grandTotal,
      amountPaid: reservation.amountPaid,
      depositAmount: reservation.depositAmount,
      assignmentReason: assignment.reason,
      needsReview: false,
      guestNotes: 'Imported from a forwarded Cloudbeds email.',
      bookingSource: reservation.source,
      cloudbedsReservationId: reservation.cloudbedsReservationId,
    });
  } else if (decision.action === 'modify' && existing && decision.patch) {
    const occupiedNumbers = occupied(stays.filter((stay) => stay !== existing), reservation);
    const assignment = planImportedRoom({
      roomType: reservation.roomType ?? existing.roomType,
      inventory,
      occupiedRoomNumbers: occupiedNumbers,
      currentRoomNumber: existing.roomNumber,
      currentStatus: 'AVAILABLE',
    });
    existing.guestName = decision.patch.primaryGuestName ?? existing.guestName;
    existing.checkIn = decision.patch.checkedInAt ?? existing.checkIn;
    existing.checkOut = decision.patch.expectedCheckoutAt ?? existing.checkOut;
    existing.nights = decision.patch.nights ?? existing.nights;
    existing.grandTotal = decision.patch.grandTotal ?? existing.grandTotal;
    existing.roomType = decision.patch.roomType ?? existing.roomType;
    existing.roomNumber = assignment.roomNumber;
    existing.assignmentReason = assignment.reason;
    existing.needsReview = assignment.needsReview;
    existing.latestNoticeAt = noticeAt ?? existing.latestNoticeAt;
    existing.guestNotes = decision.patch.guestNotes ?? existing.guestNotes;
  } else if (decision.action === 'cancel' && existing && decision.patch) {
    existing.cancelledAt = decision.patch.cancelledAt ?? existing.cancelledAt;
    existing.roomNumber = null;
    existing.latestNoticeAt = noticeAt ?? existing.latestNoticeAt;
  }
  return outcome;
}

function occupied(stays: MemoryStay[], reservation: CloudbedsEmailReservation) {
  return stays.filter((stay) => !stay.cancelledAt && stay.roomNumber && stay.checkIn < reservation.checkOut && stay.checkOut > reservation.checkIn).map((stay) => stay.roomNumber!);
}

function calendar(stays: MemoryStay[], from: Date, to: Date) {
  return stays.filter((stay) => !stay.cancelledAt && stay.checkIn < to && stay.checkOut > from);
}

describe('nested Cloudbeds fixture import', () => {
  const runnable = Boolean(parentMessage || fixtureDir);
  (runnable ? it : it.skip)('imports the extracted collection once, updates dates, and drops cancellations from the calendar', async () => {
    const files = new Set<string>();
    if (parentMessage) files.add(parentMessage);
    if (fixtureDir) {
      for (const name of readdirSync(fixtureDir)) {
        if (name.endsWith('.eml') || name.endsWith('.html')) files.add(join(fixtureDir, name));
      }
    }
    let discovered = 0;
    let nested = 0;
    let duplicates = 0;
    const seen = new Set<string>();
    const reservations: Array<{ reservation: CloudbedsEmailReservation; noticeAt: Date | null; key: string }> = [];
    let payments = 0;
    let unrecognized = 0;
    for (const file of files) {
      discovered += 1;
      if (!file.endsWith('.eml')) continue;
      const extracted = await extractCloudbedsNotices(readFileSync(file));
      nested += extracted.notices.length;
      duplicates += extracted.duplicates;
      for (const notice of extracted.notices) {
        const key = notice.messageId ?? `${notice.kind}|${notice.subject}|${notice.noticeAt?.toISOString() ?? ''}|${notice.reservation?.confirmationNumber ?? ''}`;
        if (seen.has(key)) {
          duplicates += 1;
          continue;
        }
        seen.add(key);
        if (notice.kind === 'payment') {
          payments += 1;
          continue;
        }
        if (!notice.reservation) {
          unrecognized += 1;
          continue;
        }
        reservations.push({ reservation: notice.reservation, noticeAt: notice.noticeAt, key });
      }
    }
    reservations.sort((left, right) => (left.noticeAt?.getTime() ?? Number.POSITIVE_INFINITY) - (right.noticeAt?.getTime() ?? Number.POSITIVE_INFINITY));
    const stays: MemoryStay[] = [];
    const outcomes = reservations.map((item) => ({ outcome: apply(stays, item.reservation, item.noticeAt), item }));
    const again = reservations.map((item) => apply(stays, item.reservation, item.noticeAt));
    const from = new Date(2026, 9, 1);
    const to = new Date(2027, 3, 1);
    const visible = calendar(stays, from, to);
    const kindsFor = (confirmation: string) => reservations.filter((item) => item.reservation.confirmationNumber === confirmation).map((item) => item.reservation.kind).sort();
    expect(kindsFor('4658532264370')).toEqual(['cancelled', 'confirmed']);
    const verena = stays.find((stay) => stay.confirmationNumber === '4658532264370');
    expect(verena?.cancelledAt).toBeTruthy();
    expect(verena?.roomNumber).toBeNull();
    expect(kindsFor('3143696112188')).toEqual(['cancelled']);
    expect(kindsFor('9370055361924')).toEqual(['modified']);
    expect(payments).toBe(1);
    expect(unrecognized).toBe(1);
    expect(discovered).toBeGreaterThan(5);
    expect(nested).toBeGreaterThan(5);
    expect(stays.length).toBeGreaterThan(0);
    expect(outcomes.filter((item) => item.outcome === 'IMPORTED').length).toBe(stays.length);
    expect(again.every((outcome) => outcome === 'DUPLICATE' || outcome === 'UPDATED' || outcome === 'CANCELED' || outcome === 'NEEDS_REVIEW' || outcome === 'UNMATCHED')).toBe(true);
    expect(new Set(stays.map((stay) => stay.confirmationNumber)).size).toBe(stays.length);
    expect(visible.every((stay) => !stay.cancelledAt)).toBe(true);
    expect(visible.filter((stay) => stay.roomNumber === '5' || stay.roomNumber === '9' || stay.roomNumber === '10' || ['12', '13', '14', '15'].includes(stay.roomNumber ?? '')).length).toBe(0);
    expect(payments + unrecognized).toBeGreaterThan(0);
    const modified = stays.filter((stay) => stay.guestNotes?.includes('Modified from'));
    for (const stay of modified) {
      const nights = Math.round((Date.UTC(stay.checkOut.getFullYear(), stay.checkOut.getMonth(), stay.checkOut.getDate()) - Date.UTC(stay.checkIn.getFullYear(), stay.checkIn.getMonth(), stay.checkIn.getDate())) / 86_400_000);
      expect(stay.nights).toBe(nights);
    }
  }, 60_000);
});
