export type SampleRoom = { roomID: string; roomName: string; roomTypeName: string; rate: number; weekendRate: number };
export type SampleStay = {
  reservationID: string;
  subReservationID: null;
  roomID: string;
  roomName: string;
  guestName: string;
  startDate: string;
  endDate: string;
  status: string;
  roomStatus: string;
  adults: string;
  children: string;
  balance: number;
  sourceName: string;
  tone: string;
  arriveTime: string;
  leaveTime: string;
};

type Booking = [roomID: string, guestName: string, startDate: string, endDate: string, adults: string, children: string, balance: number, sourceName: string, tone: string];

const garden = { roomTypeName: 'Garden bungalow', rate: 2300, weekendRate: 2600 };
const pool = { roomTypeName: 'Pool villa', rate: 2800, weekendRate: 3200 };
export const SAMPLE_ROOMS: SampleRoom[] = [
  { roomID: 'room-1', roomName: 'Room 1', ...garden },
  { roomID: 'room-2', roomName: 'Room 2', ...garden },
  { roomID: 'room-3', roomName: 'Room 3', ...garden },
  { roomID: 'room-12', roomName: 'Room 12', ...garden },
  { roomID: 'room-15', roomName: 'Room 15', ...garden },
  { roomID: 'family', roomName: 'Family room', ...garden },
  { roomID: 'room-8', roomName: 'Room 8', ...pool },
  { roomID: 'room-9', roomName: 'Room 9', ...pool },
];

const BOOKINGS: Booking[] = [
  ['room-1', 'Arlo Warren', '2026-10-22', '2026-10-25', '1', '0', 2400, 'Walk-in', 'pink'],
  ['room-1', 'Emily Watanabe', '2026-10-25', '2026-10-29', '2', '1', 6100, 'Booking.com', 'blue'],
  ['room-1', 'Noah Thompson', '2026-10-29', '2026-11-02', '2', '0', 4800, 'Direct', 'yellow'],
  ['room-1', 'Lina Chen', '2026-11-02', '2026-11-06', '1', '0', 3200, 'Direct', 'pink'],
  ['room-2', 'Maya Chen', '2026-10-22', '2026-10-26', '2', '0', 4500, 'Agoda', 'blue'],
  ['room-2', 'Aung Min', '2026-10-26', '2026-10-31', '2', '2', 8900, 'Walk-in', 'orange'],
  ['room-2', 'Priya Shah', '2026-10-31', '2026-11-04', '2', '0', 5400, 'Agoda', 'yellow'],
  ['room-3', 'James Okonkwo', '2026-10-23', '2026-10-27', '1', '0', 3600, 'Direct', 'pink'],
  ['room-3', 'Elena Rossi', '2026-10-27', '2026-11-01', '2', '1', 7200, 'Booking.com', 'blue'],
  ['room-3', 'Chris Dalton', '2026-11-01', '2026-11-05', '2', '0', 4100, 'Direct', 'yellow'],
  ['room-12', 'Hanna Berg', '2026-10-22', '2026-10-26', '2', '0', 5100, 'Direct', 'blue'],
  ['room-12', 'Sophie Martin', '2026-10-30', '2026-11-03', '2', '0', 4200, 'Direct', 'pink'],
  ['room-12', 'Owen Price', '2026-11-03', '2026-11-07', '1', '0', 3900, 'Walk-in', 'yellow'],
  ['room-15', 'The Nakamura family', '2026-10-22', '2026-10-28', '2', '2', 12800, 'Direct', 'orange'],
  ['room-15', 'Sofia Alvarez', '2026-10-28', '2026-11-02', '2', '0', 5600, 'Booking.com', 'blue'],
  ['room-15', 'Kenji Sato', '2026-11-02', '2026-11-06', '2', '1', 6400, 'Agoda', 'pink'],
  ['family', 'Amara Diallo', '2026-10-24', '2026-10-29', '2', '1', 8700, 'Direct', 'yellow'],
  ['family', 'Luca Bianchi', '2026-10-29', '2026-11-04', '2', '2', 11200, 'Walk-in', 'blue'],
  ['family', 'Mei Lin', '2026-11-04', '2026-11-09', '2', '1', 7600, 'Booking.com', 'pink'],
  ['room-8', 'Jonah Ellis', '2026-10-22', '2026-10-27', '1', '0', 3300, 'Direct', 'pink'],
  ['room-8', 'Nora Ibrahim', '2026-10-27', '2026-11-01', '2', '0', 4900, 'Agoda', 'blue'],
  ['room-8', 'Felix Moreau', '2026-11-01', '2026-11-06', '2', '0', 5200, 'Direct', 'yellow'],
  ['room-9', 'Hana Suzuki', '2026-10-22', '2026-10-26', '2', '0', 4700, 'Booking.com', 'blue'],
  ['room-9', 'Diego Alvarez', '2026-10-26', '2026-11-01', '2', '1', 6800, 'Direct', 'orange'],
  ['room-9', 'Claire Dubois', '2026-11-01', '2026-11-05', '1', '0', 3500, 'Walk-in', 'pink'],
];

const LATER_GUESTS = ['Samira Hassan', 'Theo Nguyen', 'Isla Campbell', 'Mateo Ruiz', 'Yara Haddad', 'Leo Martins', 'Ines Costa', 'Adam Rahman'];
const TONES = ['pink', 'blue', 'yellow', 'orange'];

function addDays(value: string, days: number) {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function laterBookings(): Booking[] {
  const extra: Booking[] = [];
  for (const room of SAMPLE_ROOMS) {
    const last = BOOKINGS.filter((booking) => booking[0] === room.roomID).map((booking) => booking[3]).sort().at(-1);
    let cursor = last ?? '2026-11-06';
    let index = room.roomName.length;
    while (cursor < '2026-12-31') {
      const end = addDays(cursor, 4 + (index % 3));
      extra.push([
        room.roomID,
        LATER_GUESTS[index % LATER_GUESTS.length],
        cursor,
        end,
        index % 2 === 0 ? '2' : '1',
        index % 3 === 0 ? '1' : '0',
        2800 + (index % 5) * 900,
        index % 2 === 0 ? 'Direct' : 'Booking.com',
        TONES[index % TONES.length],
      ]);
      cursor = end;
      index += 1;
    }
  }
  return extra;
}

function todayIso() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function sampleStays(from: string, to: string, statusOf: (reservationID: string) => string | undefined): SampleStay[] {
  const today = todayIso();
  const roomNames = new Map(SAMPLE_ROOMS.map((room) => [room.roomID, room.roomName]));
  return [...BOOKINGS, ...laterBookings()].flatMap((booking) => {
    const [roomID, guestName, startDate, endDate, adults, children, balance, sourceName, tone] = booking;
    if (!(startDate < to && endDate > from)) return [];
    const reservationID = `sample-${roomID}-${startDate}`;
    const roomStatus = statusOf(reservationID) ?? (endDate <= today ? 'checked_out' : startDate <= today ? 'in_house' : 'not_checked_in');
    return [{
      reservationID,
      subReservationID: null,
      roomID,
      roomName: roomNames.get(roomID) ?? roomID,
      guestName,
      startDate,
      endDate,
      status: roomStatus === 'in_house' ? 'checked_in' : roomStatus === 'checked_out' ? 'checked_out' : 'confirmed',
      roomStatus,
      adults,
      children,
      balance: roomStatus === 'checked_out' ? 0 : balance,
      sourceName,
      tone,
      arriveTime: '14:00',
      leaveTime: '12:00',
    }];
  });
}
