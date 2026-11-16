import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { simpleParser } from 'mailparser';
import { cloudbedsNoticeKind, extractCloudbedsNotices, nightsBetween, parseCloudbedsReservation, pickImportedStay, planStayNotice, readCloudbedsMessage, reservationImportAction, sameMessageAlreadyStored } from './cloudbeds-email';

const htmlFixture = readFileSync(join(__dirname, 'fixtures', 'cloudbeds-confirmed.html'), 'utf8');
const mimeFixture = readFileSync(join(__dirname, 'fixtures', 'cloudbeds-confirmed.eml'));

describe('forwarded Cloudbeds reservation fixture', () => {
  it('reads the reservation table from the real HTML email', () => {
    const subject = /Subject:\s*([^<]+)/i.exec(htmlFixture)?.[1]?.replace(/\s+/g, ' ').trim();
    const reservation = parseCloudbedsReservation({ subject, html: htmlFixture });
    expect(reservation).toMatchObject({
      kind: 'confirmed',
      guestName: 'Philipp Bachmann',
      guestEmail: 'pbachm.233254@guest.booking.com',
      source: 'Booking.com',
      confirmationNumber: '8504018395590',
      sourceReservationId: '5055926744',
      nights: 2,
      roomType: 'Superior Queen (Standard Rate)',
      roomNumber: null,
      adults: 1,
      children: 0,
      currency: 'THB',
      averageNightlyRate: '2600.00',
      grandTotal: '5200.00',
      depositAmount: '5200.00',
      amountPaid: '0.00',
      balanceDue: '5200.00',
    });
    expect(reservation?.checkIn.getFullYear()).toBe(2026);
    expect(reservation?.checkIn.getMonth()).toBe(10);
    expect(reservation?.checkIn.getDate()).toBe(21);
    expect(reservation?.checkOut.getDate()).toBe(23);
    expect(reservation?.checkOut.getTime()).toBeGreaterThan(reservation?.checkIn.getTime() ?? 0);
    expect(reservation?.nightlyRates).toEqual([
      { night: reservation?.checkIn, amount: '2600.00', currency: 'THB' },
      expect.objectContaining({ amount: '2600.00', currency: 'THB' }),
    ]);
    expect(reservation?.nightlyRates[1]?.night.getDate()).toBe(22);
    expect(reservation?.guestEmail).not.toContain('gmail.com');
    expect(typeof reservation?.grandTotal).toBe('string');
  });

  it('parses the original notice from the forwarded MIME message', async () => {
    const message = await readCloudbedsMessage(mimeFixture);
    expect(message.reservation).toMatchObject({
      kind: 'confirmed',
      guestName: 'Philipp Bachmann',
      confirmationNumber: '8504018395590',
      source: 'Booking.com',
      grandTotal: '5200.00',
      depositAmount: '5200.00',
      amountPaid: '0.00',
      balanceDue: '5200.00',
      roomNumber: null,
    });
    expect(message.from).not.toBe(message.reservation?.guestEmail);
  });

  it('keeps modifications and cancellations from becoming new reservations', () => {
    expect(cloudbedsNoticeKind('Reservation CONFIRMED - guest')).toBe('confirmed');
    expect(cloudbedsNoticeKind('Reservation MODIFIED - guest')).toBe('modified');
    expect(cloudbedsNoticeKind('Reservation CANCELLED - guest')).toBe('cancelled');
    expect(reservationImportAction('confirmed', false)).toBe('create');
    expect(reservationImportAction('confirmed', true)).toBe('duplicate');
    expect(reservationImportAction('modified', false)).toBe('review');
    expect(reservationImportAction('modified', true)).toBe('modify');
    expect(reservationImportAction('cancelled', false)).toBe('review');
    expect(reservationImportAction('cancelled', true)).toBe('cancel');
    expect(reservationImportAction('unknown', true)).toBe('review');
    const cancelled = parseCloudbedsReservation({ subject: 'Reservation CANCELLED - Reservation #8504018395590', html: htmlFixture });
    expect(cancelled?.kind).toBe('cancelled');
    expect(cancelled?.confirmationNumber).toBe('8504018395590');
  });
});

const root = join(__dirname, '../../..');
const stay = {
  primaryGuestName: 'Dietmar Koch',
  guestNotes: 'Staff note.',
  bookingSource: 'Booking.com',
  amountPaid: '100.00',
  cloudbedsReservationId: '190507508',
  cancelledAt: null,
  latestNoticeAt: null as Date | null,
};

describe('forwarded Cloudbeds modification and cancellation', () => {
  it('parses the Booking.com modification from the HTML and the plain text', async () => {
    const message = await readCloudbedsMessage(readFileSync(join(root, 'email-7.eml')));
    expect(message.from).toBe('admin@cloudbeds.com');
    expect(message.subject).toBe('Booking.com Modified Reservation - Dietmar Koch - #7928979168239');
    expect(message.noticeAt?.getFullYear()).toBe(2026);
    expect(message.noticeAt?.getMonth()).toBe(10);
    expect(message.noticeAt?.getDate()).toBe(2);
    expect(message.reservation).toMatchObject({
      kind: 'modified',
      guestName: 'Dietmar Koch',
      guestEmail: 'dkoch.501120@guest.booking.com',
      source: 'Booking.com',
      confirmationNumber: '7928979168239',
      sourceReservationId: '5393127479',
      cloudbedsReservationId: '190507508',
      nights: 3,
      roomType: 'Standard Bungalow',
      adults: 2,
      children: 0,
      currency: 'THB',
      averageNightlyRate: '2500.00',
      grandTotal: '7500.00',
      depositAmount: '0.00',
      amountPaid: null,
      balanceDue: '7500.00',
    });
    expect(message.reservation?.checkIn.getMonth()).toBe(2);
    expect(message.reservation?.checkIn.getDate()).toBe(1);
    expect(message.reservation?.checkOut.getDate()).toBe(4);
    expect(message.reservation?.nightlyRates).toHaveLength(3);
    const decoded = await simpleParser(readFileSync(join(root, 'email-7.eml')));
    const plain = parseCloudbedsReservation({ subject: message.subject, text: decoded.text ?? '' });
    const htmlOnly = parseCloudbedsReservation({ subject: message.subject, html: typeof decoded.html === 'string' ? decoded.html : '' });
    expect(plain?.confirmationNumber).toBe('7928979168239');
    expect(plain?.grandTotal).toBe('7500.00');
    expect(plain?.amountPaid).toBeNull();
    expect(plain?.cloudbedsReservationId).toBe('190507508');
    expect(htmlOnly?.guestName).toBe('Dietmar Koch');
    expect(htmlOnly?.sourceReservationId).toBe('5393127479');
  });

  it('parses the cancellation without treating the deposit as amount paid', async () => {
    const message = await readCloudbedsMessage(readFileSync(join(root, 'email-8.eml')));
    expect(message.from).toBe('admin@cloudbeds.com');
    expect(message.subject).toContain('Reservation Canceled - Julia Bilyaeva');
    expect(message.reservation).toMatchObject({
      kind: 'cancelled',
      guestName: 'Julia Bilyaeva',
      guestEmail: 'jbilya.618658@guest.booking.com',
      source: 'Booking.com',
      confirmationNumber: '5443734844866',
      sourceReservationId: '6865321788',
      cloudbedsReservationId: '189338481',
      nights: 6,
      roomType: 'Standard Bungalow (Standard Rate)',
      adults: 2,
      children: 0,
      currency: 'THB',
      averageNightlyRate: '2366.67',
      grandTotal: '14200.00',
      depositAmount: '14200.00',
      amountPaid: '0.00',
      balanceDue: '14200.00',
    });
    expect(message.reservation?.amountPaid).not.toBe(message.reservation?.depositAmount);
    expect(message.reservation?.checkIn.getMonth()).toBe(11);
    expect(message.reservation?.checkIn.getDate()).toBe(11);
    expect(message.reservation?.checkOut.getDate()).toBe(17);
    expect(message.reservation?.nightlyRates.map((rate) => rate.amount)).toEqual(['2300.00', '2300.00', '2300.00', '2300.00', '2500.00', '2500.00']);
  });

  it('still reads the existing confirmation fixtures', async () => {
    for (const name of ['email-3.eml', 'email-4.eml', 'email-5.eml']) {
      const message = await readCloudbedsMessage(readFileSync(join(root, name)));
      expect(message.from).toBe('admin@cloudbeds.com');
      expect(message.reservation?.kind).toBe('confirmed');
      expect(message.reservation?.source).toBe('Booking.com');
      expect(message.reservation?.confirmationNumber).toMatch(/^\d{10,}$/);
      expect(message.reservation?.cloudbedsReservationId).toMatch(/^\d{6,}$/);
      expect(message.reservation?.amountPaid).toBe('0.00');
      expect(message.reservation?.depositAmount).not.toBe('0.00');
    }
  });

  it('updates a matched reservation and does not copy the deposit into amount paid', async () => {
    const reservation = (await readCloudbedsMessage(readFileSync(join(root, 'email-7.eml')))).reservation;
    expect(reservation).toBeTruthy();
    const plan = planStayNotice({ existing: stay, reservation: reservation!, noticeAt: new Date('2026-11-02T02:10:00Z'), reference: '<modify@cloudbeds>' });
    expect(plan.action).toBe('modify');
    expect(plan.replaceNights).toBe(true);
    expect(plan.patch).not.toHaveProperty('amountPaid');
    expect(plan.patch?.depositAmount).toBe('0.00');
    expect(plan.patch?.payment?.amountPaid).toBe('100.00');
    expect(plan.patch?.grandTotal).toBe('7500.00');
    expect(plan.patch?.primaryGuestName).toBe('Dietmar Koch');
    expect(plan.patch?.guestNotes).toContain('Staff note.');
    expect(plan.patch).not.toHaveProperty('payments');
    expect(plan.patch).not.toHaveProperty('charges');
    expect(planStayNotice({ existing: null, reservation: reservation!, noticeAt: null, reference: null }).action).toBe('review');
  });

  it('cancels a matched reservation without rewriting payments or folio amounts', async () => {
    const reservation = (await readCloudbedsMessage(readFileSync(join(root, 'email-8.eml')))).reservation;
    const booked = { ...stay, primaryGuestName: 'Julia Bilyaeva', amountPaid: '0.00', cloudbedsReservationId: '189338481' };
    const plan = planStayNotice({ existing: booked, reservation: reservation!, noticeAt: new Date('2026-10-29T18:51:00Z'), reference: '<cancel@cloudbeds>' });
    expect(plan.action).toBe('cancel');
    expect(plan.replaceNights).toBe(false);
    expect(plan.patch?.cancelledAt).toBeTruthy();
    expect(plan.patch).not.toHaveProperty('amountPaid');
    expect(plan.patch).not.toHaveProperty('depositAmount');
    expect(plan.patch).not.toHaveProperty('grandTotal');
    expect(plan.patch).not.toHaveProperty('primaryGuestName');
    expect(plan.patch?.guestNotes).toContain('Cancelled from the forwarded Cloudbeds email <cancel@cloudbeds>.');
    expect(planStayNotice({ existing: null, reservation: reservation!, noticeAt: null, reference: null }).detail).toContain('Manual review');
  });

  it('ignores a repeated message and an older notice', async () => {
    expect(sameMessageAlreadyStored('already-stored')).toBe(true);
    expect(sameMessageAlreadyStored(null)).toBe(false);
    const reservation = (await readCloudbedsMessage(readFileSync(join(root, 'email-7.eml')))).reservation!;
    const newer = planStayNotice({
      existing: { ...stay, latestNoticeAt: new Date('2026-11-03T00:00:00Z') },
      reservation,
      noticeAt: new Date('2026-10-29T00:00:00Z'),
      reference: '<old@cloudbeds>',
    });
    expect(newer.action).toBe('stale');
    expect(newer.patch).toBeNull();
    const confirmed = { ...reservation, kind: 'confirmed' as const };
    expect(planStayNotice({ existing: stay, reservation: confirmed, noticeAt: new Date('2026-11-04T00:00:00Z'), reference: null }).action).toBe('duplicate');
    expect(pickImportedStay([
      { id: 'a', bookingSource: 'Booking.com', confirmationNumber: '111', sourceReservationId: null, cloudbedsReservationId: null },
      { id: 'b', bookingSource: 'Expedia', confirmationNumber: '222', sourceReservationId: null, cloudbedsReservationId: null },
    ], { ...reservation, confirmationNumber: '111', sourceReservationId: 'nope', cloudbedsReservationId: 'nope' }).stay?.id).toBe('a');
    expect(cloudbedsNoticeKind('Hello from the desk')).toBe('unknown');
  });

  it('reads a confirmed reservation from an attached message/rfc822 without using the outer Gmail date', async () => {
    const message = await readCloudbedsMessage(readFileSync(join(root, 'email-12.eml')));
    expect(message.outer.subject).toBeNull();
    expect(message.outer.from).toBe('barefootproject.kohphayam@gmail.com');
    expect(message.outer.date?.getFullYear()).toBe(2026);
    expect(message.outer.date?.getMonth()).toBe(10);
    expect(message.outer.date?.getDate()).toBe(2);
    expect(message.date).toEqual(message.outer.date);
    expect(message.from).toBe('admin@cloudbeds.com');
    expect(message.subject).toBe('Reservation CONFIRMED - Alexander Seidel - Reservation #6963738589644');
    expect(message.noticeAt?.getFullYear()).toBe(2026);
    expect(message.noticeAt?.getMonth()).toBe(5);
    expect(message.noticeAt?.getDate()).toBe(16);
    expect(message.reservation).toMatchObject({
      kind: 'confirmed',
      guestName: 'Alexander Seidel',
      guestEmail: 'alexseidel@ymail.com',
      confirmationNumber: '6963738589644',
      sourceReservationId: null,
      cloudbedsReservationId: '178164718',
      paymentMethod: 'ebanking',
      source: 'Website/Booking Engine',
      nights: 8,
      roomType: 'villa room 11',
      adults: 2,
      children: 1,
      currency: 'THB',
      averageNightlyRate: '5800.00',
      grandTotal: '46400.00',
      depositAmount: '46400.00',
      amountPaid: '0.00',
      balanceDue: '46400.00',
    });
    expect(message.reservation?.amountPaid).not.toBe(message.reservation?.depositAmount);
    expect(message.reservation?.checkIn.getFullYear()).toBe(2027);
    expect(message.reservation?.checkIn.getMonth()).toBe(1);
    expect(message.reservation?.checkIn.getDate()).toBe(7);
    expect(message.reservation?.checkOut.getDate()).toBe(15);
    expect(message.reservation?.nightlyRates).toHaveLength(8);
    expect(planStayNotice({ existing: null, reservation: message.reservation!, noticeAt: message.noticeAt, reference: message.messageId }).action).toBe('create');
    expect(planStayNotice({ existing: { ...stay, primaryGuestName: 'Alexander Seidel', bookingSource: 'Website/Booking Engine', amountPaid: '0.00', cloudbedsReservationId: '178164718' }, reservation: message.reservation!, noticeAt: message.noticeAt, reference: message.messageId }).action).toBe('duplicate');
  });

  it('reads html inside a nested multipart/alternative .eml when the outer subject is empty', async () => {
    const nested = [
      'From: Barefoot Project <admin@cloudbeds.com>',
      'Date: Tue, 16 Jun 2026 14:26:26 +0000',
      'Subject: Reservation CONFIRMED - Nested Guest - Reservation #1234567890123',
      'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary="inner"',
      '',
      '--inner',
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      'This plain part has no reservation table.',
      '--inner',
      'Content-Type: text/html; charset="UTF-8"',
      '',
      '<table><tr><td>Guest Name</td><td>Nested Guest</td></tr><tr><td>Email</td><td>nested@example.com</td></tr><tr><td>Confirmation Number</td><td>1234567890123</td></tr><tr><td>Payment Method</td><td>card</td></tr><tr><td>Source</td><td>Website/Booking Engine</td></tr><tr><td>Check-in</td><td>Check-out</td><td>Days</td></tr><tr><td>01/03/2027</td><td>04/03/2027</td><td>3</td></tr><tr><td>Grand Total</td><td>THB 300.00</td></tr><tr><td>Deposit Amount</td><td>THB 300.00</td></tr><tr><td>Amount Paid</td><td>THB 0.00</td></tr><tr><td>Balance Due</td><td>THB 300.00</td></tr></table>',
      '--inner--',
      '',
    ].join('\r\n');
    const outer = [
      'From: Barefoot Project <barefootproject.kohphayam@gmail.com>',
      'Date: Mon, 2 Nov 2026 18:42:48 +0700',
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
      nested,
      '--outer--',
      '',
    ].join('\r\n');
    const message = await readCloudbedsMessage(outer);
    expect(message.outer.subject).toBeNull();
    expect(message.subject).toContain('Nested Guest');
    expect(message.from).toBe('admin@cloudbeds.com');
    expect(message.noticeAt?.getMonth()).toBe(5);
    expect(message.date?.getMonth()).toBe(10);
    expect(message.reservation).toMatchObject({
      kind: 'confirmed',
      guestName: 'Nested Guest',
      confirmationNumber: '1234567890123',
      paymentMethod: 'card',
      depositAmount: '300.00',
      amountPaid: '0.00',
    });
    expect(message.reservation?.amountPaid).not.toBe(message.reservation?.depositAmount);
  });

  it('extracts every nested reservation and does not treat the wrapper or a duplicate part as another booking', async () => {
    const first = cloudbedsPart('confirmed-a@cloudbeds.com', 'Reservation CONFIRMED - Ada - Reservation #1111111111111', 'Ada', '1111111111111', '01/04/2027', '04/04/2027');
    const second = cloudbedsPart('modified-b@cloudbeds.com', 'Reservation MODIFIED - Bea - Reservation #2222222222222', 'Bea', '2222222222222', '02/04/2027', '06/04/2027');
    const payment = [
      'From: Cloudbeds <admin@cloudbeds.com>',
      'Date: Tue, 16 Jun 2026 18:00:00 +0000',
      'Message-ID: <payment-t@cloudbeds.com>',
      'Subject: Payment #T2950680 Confirmed for your Cloudbeds account',
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset="UTF-8"',
      '',
      '<p>Payment confirmed. This is not a reservation.</p>',
    ].join('\r\n');
    const outer = [
      'From: Front Desk <barefootproject.kohphayam@gmail.com>',
      'Date: Mon, 2 Nov 2026 18:42:48 +0700',
      'Message-ID: <wrapper@gmail.com>',
      'Subject: 1',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="batch"',
      '',
      '--batch',
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      'Forwarded batch.',
      '--batch',
      'Content-Type: message/rfc822',
      '',
      first,
      '--batch',
      'Content-Type: message/rfc822',
      '',
      first,
      '--batch',
      'Content-Type: message/rfc822',
      '',
      second,
      '--batch',
      'Content-Type: message/rfc822',
      '',
      payment,
      '--batch--',
      '',
    ].join('\r\n');
    const extracted = await extractCloudbedsNotices(outer);
    expect(extracted.wrappers).toBe(1);
    expect(extracted.duplicates).toBeGreaterThan(0);
    expect(extracted.notices.map((notice) => notice.reservation?.confirmationNumber ?? notice.kind)).toEqual(['1111111111111', '2222222222222', 'payment']);
    expect(extracted.notices[1].reservation).toMatchObject({ kind: 'modified', guestName: 'Bea', nights: 3 });
    expect(extracted.notices[2].reservation).toBeNull();
    const again = await extractCloudbedsNotices(outer);
    expect(again.notices).toHaveLength(extracted.notices.length);
  });

  it('moves a modified stay onto the new dates and does not let an older confirmation reopen it', () => {
    const reservation = parseCloudbedsReservation({
      subject: 'Reservation MODIFIED - Ada - Reservation #1111111111111',
      html: '<table><tr><td>Guest Name</td><td>Ada</td></tr><tr><td>Confirmation Number</td><td>1111111111111</td></tr><tr><td>Source</td><td>Booking.com</td></tr><tr><td>Check-in</td><td>Check-out</td><td>Days</td></tr><tr><td>10/05/2027</td><td>15/05/2027</td><td>5</td></tr><tr><td>Grand Total</td><td>THB 500.00</td></tr></table>',
    });
    expect(reservation?.nights).toBe(5);
    const plan = planStayNotice({
      existing: { ...stay, latestNoticeAt: new Date('2027-01-01T00:00:00Z') },
      reservation: reservation!,
      noticeAt: new Date('2027-02-01T00:00:00Z'),
      reference: '<modify-dates@cloudbeds.com>',
    });
    expect(plan.action).toBe('modify');
    expect(plan.patch?.checkedInAt?.getDate()).toBe(10);
    expect(plan.patch?.expectedCheckoutAt?.getDate()).toBe(15);
    expect(plan.patch?.nights).toBe(nightsBetween(reservation!.checkIn, reservation!.checkOut));
    const cancelled = { ...stay, cancelledAt: new Date('2027-03-01T00:00:00Z'), latestNoticeAt: new Date('2027-03-01T00:00:00Z') };
    const older = planStayNotice({
      existing: cancelled,
      reservation: { ...reservation!, kind: 'confirmed' },
      noticeAt: new Date('2027-01-15T00:00:00Z'),
      reference: '<old-confirm@cloudbeds.com>',
    });
    expect(older.action).toBe('stale');
    expect(older.patch).toBeNull();
    expect(planStayNotice({ existing: { ...stay, latestNoticeAt: new Date('2027-01-01T00:00:00Z') }, reservation: reservation!, noticeAt: null, reference: null }).action).toBe('review');
    expect(cloudbedsNoticeKind('Payment #T1 Confirmed for your Cloudbeds account')).toBe('payment');
    expect(reservationImportAction('payment', false)).toBe('review');
  });
});

function cloudbedsPart(id: string, subject: string, guest: string, confirmation: string, checkIn: string, checkOut: string) {
  return [
    'From: Cloudbeds <admin@cloudbeds.com>',
    'Date: Tue, 16 Jun 2026 14:26:26 +0000',
    `Message-ID: <${id}>`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset="UTF-8"',
    '',
    `<table><tr><td>Guest Name</td><td>${guest}</td></tr><tr><td>Email</td><td>${guest.toLowerCase()}@example.com</td></tr><tr><td>Confirmation Number</td><td>${confirmation}</td></tr><tr><td>Source</td><td>Booking.com</td></tr><tr><td>Check-in</td><td>Check-out</td><td>Days</td></tr><tr><td>${checkIn}</td><td>${checkOut}</td><td>3</td></tr><tr><td>Grand Total</td><td>THB 300.00</td></tr><tr><td>Deposit Amount</td><td>THB 300.00</td></tr><tr><td>Amount Paid</td><td>THB 0.00</td></tr><tr><td>Balance Due</td><td>THB 300.00</td></tr></table>`,
  ].join('\r\n');
}
