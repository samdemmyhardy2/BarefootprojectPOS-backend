import { bangkokDayKey, parseCloudbedsReservation, pickImportedStay, planStayNotice } from './cloudbeds-email';
import { planRoomAssignment, UNASSIGNED_MANUAL_SELECTION_REQUIRED, type AssignableRoom } from './room-assignment';
import { beginExclusiveSync, renderImportAttempt } from './reservation-mail.queue';

const inventory: AssignableRoom[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15'].map((roomNumber) => ({ roomNumber, status: 'AVAILABLE' }));

function reservation(kind: 'confirmed' | 'modified', overrides: { confirmation?: string; cloudbeds?: string; checkIn?: string; checkOut?: string; room?: string; guest?: string; total?: string } = {}) {
  const checkIn = overrides.checkIn ?? '15/02/2027';
  const checkOut = overrides.checkOut ?? '19/02/2027';
  const parsed = parseCloudbedsReservation({
    subject: kind === 'modified' ? 'Booking.com Modified Reservation - Stella Anastasia' : 'Reservation CONFIRMED - Stella Anastasia',
    html: `<table><tr><td>Guest Name</td><td>${overrides.guest ?? 'Stella Anastasia'}</td></tr><tr><td>Confirmation Number</td><td>${overrides.confirmation ?? '2850774638039'}</td></tr><tr><td>Source</td><td>Booking.com</td></tr><tr><td>Check-in</td><td>Check-out</td><td>Days</td></tr><tr><td>${checkIn}</td><td>${checkOut}</td><td>4</td></tr><tr><td>Room Type</td><td>${overrides.room ?? 'Villa no 11'}</td></tr><tr><td>Grand Total</td><td>THB ${overrides.total ?? '4000.00'}</td></tr><tr><td>Amount Paid</td><td>THB 0.00</td></tr></table> https://hotels.cloudbeds.com/reservations/${overrides.cloudbeds ?? '190774585'}`,
  });
  if (!parsed) throw new Error('fixture did not parse');
  return { ...parsed, kind };
}

const existing = {
  primaryGuestName: 'Stella Anastasia',
  guestNotes: null,
  bookingSource: 'Booking.com',
  amountPaid: '0.00',
  cloudbedsReservationId: '190774585',
  cancelledAt: null as Date | null,
  latestNoticeAt: new Date('2027-02-01T00:00:00Z'),
  checkedInAt: new Date(Date.UTC(2027, 1, 15, 7, 0, 0)),
  expectedCheckoutAt: new Date(Date.UTC(2027, 1, 19, 4, 0, 0)),
  roomType: 'Villa no 11',
  grandTotal: '4000.00',
};

describe('Cloudbeds reservation matching and sync', () => {
  it('updates the original stay when the Cloudbeds id matches, even if another stay has the confirmation number', () => {
    const picked = pickImportedStay([
      { id: 'original', bookingSource: 'Booking.com', confirmationNumber: 'OLD-NUMBER', sourceReservationId: null, cloudbedsReservationId: '190774585' },
      { id: 'other', bookingSource: 'Booking.com', confirmationNumber: '2850774638039', sourceReservationId: null, cloudbedsReservationId: '999' },
    ], reservation('modified'));
    expect(picked).toMatchObject({ stay: { id: 'original' }, strategy: 'cloudbedsReservationId', ambiguous: false });
  });

  it('keeps two Cloudbeds ids for the same guest as separate bookings', () => {
    const stays = [
      { id: 'a', bookingSource: 'Booking.com', confirmationNumber: '111', sourceReservationId: null, cloudbedsReservationId: '190774585' },
      { id: 'b', bookingSource: 'Booking.com', confirmationNumber: '222', sourceReservationId: null, cloudbedsReservationId: '190774586' },
    ];
    expect(pickImportedStay(stays, reservation('confirmed', { cloudbeds: '190774586', confirmation: '222' })).stay?.id).toBe('b');
    expect(pickImportedStay(stays, reservation('confirmed')).stay?.id).toBe('a');
  });

  it('moves a modification onto the same stay and recalculates the nights', () => {
    const incoming = reservation('modified', { checkIn: '16/02/2027', checkOut: '21/02/2027' });
    const plan = planStayNotice({ existing, reservation: incoming, noticeAt: new Date('2027-02-02T00:00:00Z'), reference: '<modify@cloudbeds.com>' });
    expect(plan.action).toBe('modify');
    expect(plan.patch?.nights).toBe(5);
    expect(bangkokDayKey(plan.patch?.checkedInAt ?? incoming.checkIn)).toBe('2027-02-16');
    expect(bangkokDayKey(plan.patch?.expectedCheckoutAt ?? incoming.checkOut)).toBe('2027-02-21');
  });

  it('lets a newer confirmation replace an older cancellation and keeps the same stay', () => {
    const plan = planStayNotice({
      existing: { ...existing, cancelledAt: new Date('2027-02-01T00:00:00Z'), latestNoticeAt: new Date('2027-02-01T00:00:00Z') },
      reservation: reservation('confirmed', { checkIn: '16/02/2027', checkOut: '21/02/2027' }),
      noticeAt: new Date('2027-02-05T00:00:00Z'),
      reference: '<later@cloudbeds.com>',
    });
    expect(plan.action).toBe('modify');
    expect(plan.patch?.cancelledAt).toBeNull();
    expect(plan.patch?.nights).toBe(5);
  });

  it('does not let an older confirmation reopen a canceled stay or create a second one', () => {
    const plan = planStayNotice({
      existing: { ...existing, cancelledAt: new Date('2027-02-03T00:00:00Z'), latestNoticeAt: new Date('2027-02-03T00:00:00Z') },
      reservation: reservation('confirmed', { checkIn: '16/02/2027', checkOut: '21/02/2027' }),
      noticeAt: new Date('2027-02-01T00:00:00Z'),
      reference: '<old@cloudbeds.com>',
    });
    expect(plan.action).toBe('stale');
    expect(plan.patch).toBeNull();
    expect(planStayNotice({ existing: null, reservation: reservation('modified'), noticeAt: new Date('2027-02-02T00:00:00Z'), reference: null }).action).toBe('review');
  });

  it('leaves choice room types and Family suite unassigned', () => {
    expect(planRoomAssignment({ roomType: 'Family suite', inventory, occupiedRoomNumbers: [] })).toEqual({ roomNumber: null, reason: UNASSIGNED_MANUAL_SELECTION_REQUIRED });
    expect(planRoomAssignment({ roomType: 'Standard Bungalow', inventory, occupiedRoomNumbers: [] }).roomNumber).toBeNull();
    expect(planRoomAssignment({ roomType: 'Double room with terrace', inventory, occupiedRoomNumbers: [] }).roomNumber).toBeNull();
    expect(planRoomAssignment({ roomType: 'Villa no 11', inventory, occupiedRoomNumbers: [] })).toEqual({ roomNumber: '11', reason: null });
  });

  it('records a stage log and refuses a second sync while one is running', () => {
    const text = renderImportAttempt({
      runId: 'sync-test',
      messageId: '<modify@cloudbeds.com>',
      subject: 'Booking.com Modified Reservation',
      from: 'admin@cloudbeds.com',
      noticeAt: new Date('2027-02-02T00:00:00Z'),
      stages: [{ stage: 'RESERVATION MATCHING', status: 'SUCCESS', detail: 'Matching Strategy: cloudbedsReservationId' }],
      result: 'UPDATED',
    });
    expect(text).toContain('FINAL RESULT: UPDATED');
    expect(text).toContain('admin@cloudbeds.com');
    expect(text).not.toContain('PASSWORD');
    const state = { running: false };
    expect(beginExclusiveSync(state)).toBe(true);
    expect(beginExclusiveSync(state)).toBe(false);
    state.running = false;
    expect(beginExclusiveSync(state)).toBe(true);
  });
});
