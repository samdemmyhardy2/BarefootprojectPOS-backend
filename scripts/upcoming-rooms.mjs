// Prints guests who have not checked out and whose checkout day is today or later,
// then sends the same list to the saved receipt printer.
// Usage: node scripts/upcoming-rooms.mjs
import 'dotenv/config';
import { connect as connectTcp } from 'node:net';
import pg from 'pg';

const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

function bangkokDayStart(now = new Date()) {
  const shifted = new Date(now.getTime() + BANGKOK_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - BANGKOK_OFFSET_MS);
}

function bangkokStamp(value) {
  if (!value) return '';
  const shifted = new Date(value.getTime() + BANGKOK_OFFSET_MS);
  const date = `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
  const time = `${String(shifted.getUTCHours()).padStart(2, '0')}:${String(shifted.getUTCMinutes()).padStart(2, '0')}`;
  return `${date} ${time}`;
}

function ascii(value) {
  return value.normalize('NFD').replace(/\p{M}/gu, '').replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim();
}

function isPrivateIpv4(ip) {
  const parts = ip.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function monthLabel(stamp) {
  const [year, month] = stamp.split('-').map(Number);
  return `${MONTHS[month - 1] ?? ''} ${year ?? ''}`.trim();
}

function slipBytes(lines) {
  const width = 48;
  const cut = (value) => ascii(value).slice(0, width);
  const chunks = [
    Buffer.from([0x1b, 0x40, 0x1b, 0x61, 0x01, 0x1b, 0x45, 0x01]),
    Buffer.from(`${cut('TABLE & THYME')}\n`, 'ascii'),
    Buffer.from([0x1b, 0x45, 0x00]),
    Buffer.from(`${cut('Upcoming rooms')}\n${cut(bangkokStamp(new Date()))}\n`, 'ascii'),
    Buffer.from([0x1b, 0x61, 0x00]),
    Buffer.from(`${'-'.repeat(width)}\n`, 'ascii'),
  ];
  if (!lines.length) chunks.push(Buffer.from('No upcoming stays.\n', 'ascii'));
  let month = '';
  for (const line of lines) {
    const heading = monthLabel(line.checkIn);
    if (heading !== month) {
      month = heading;
      chunks.push(Buffer.from([0x1b, 0x61, 0x01, 0x1b, 0x45, 0x01]));
      chunks.push(Buffer.from(`\n${cut(heading)}\n`, 'ascii'));
      chunks.push(Buffer.from([0x1b, 0x45, 0x00, 0x1b, 0x61, 0x00]));
    }
    const room = cut(line.room === 'Unassigned' ? 'Unassigned' : `Room ${line.room}`);
    chunks.push(Buffer.from(`${room.padEnd(12)}${cut(line.name).slice(0, width - 12)}\n`, 'ascii'));
    chunks.push(Buffer.from(`${cut(`In  ${line.checkIn}`)}\n${cut(`Out ${line.checkOut}`)}\n\n`, 'ascii'));
  }
  chunks.push(Buffer.from([0x1b, 0x64, 0x04, 0x1d, 0x56, 0x42, 0x00]));
  return Buffer.concat(chunks);
}

function sendTcp(host, port, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = connectTcp({ host, port });
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error('Connection timed out')), timeoutMs);
    socket.once('error', fail);
    socket.once('connect', () => {
      socket.write(payload, (error) => {
        if (error) { fail(error); return; }
        socket.end();
      });
    });
    socket.once('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    });
  });
}

function roomSort(left, right) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) return leftNumber - rightNumber;
  return String(left).localeCompare(String(right), undefined, { numeric: true });
}

const connectionString = process.env.DATABASE_URL?.split('?')[0];
if (!connectionString) {
  console.error('DATABASE_URL is missing. Run this from the backend folder.');
  process.exit(1);
}

const client = new pg.Client({ connectionString });
await client.connect();
try {
  const { rows } = await client.query(
    `SELECT r."roomNumber", s."primaryGuestName" AS name, s."checkedInAt", s."expectedCheckoutAt"
     FROM "RoomStay" s
     LEFT JOIN "Room" r ON r.id = s."roomId"
     WHERE s."cancelledAt" IS NULL
       AND s."checkedOutAt" IS NULL
       AND (s."expectedCheckoutAt" IS NULL OR s."expectedCheckoutAt" >= $1)
     ORDER BY s."checkedInAt" ASC`,
    [bangkokDayStart()],
  );
  const stays = rows.sort((left, right) => left.checkedInAt - right.checkedInAt || roomSort(left.roomNumber ?? '', right.roomNumber ?? ''));
  const lines = stays.map((stay) => ({
    room: stay.roomNumber ?? 'Unassigned',
    name: stay.name,
    checkIn: bangkokStamp(stay.checkedInAt),
    checkOut: bangkokStamp(stay.expectedCheckoutAt),
  }));
  const width = (key, title) => Math.max(title.length, ...lines.map((line) => line[key].length));
  const roomWidth = width('room', 'Room');
  const nameWidth = width('name', 'Name');
  const inWidth = width('checkIn', 'Check-in');
  const header = `${'Room'.padEnd(roomWidth)}  ${'Name'.padEnd(nameWidth)}  ${'Check-in'.padEnd(inWidth)}  Check-out`;
  console.log(header);
  console.log('-'.repeat(header.length));
  if (!lines.length) console.log('No upcoming stays.');
  let month = '';
  for (const line of lines) {
    const heading = monthLabel(line.checkIn);
    if (heading !== month) {
      month = heading;
      console.log(`\n${heading}`);
    }
    console.log(`${line.room.padEnd(roomWidth)}  ${line.name.padEnd(nameWidth)}  ${line.checkIn.padEnd(inWidth)}  ${line.checkOut}`);
  }

  const printer = await client.query(
    `SELECT name, "ipAddress", port, "connectionType", enabled
     FROM "Printer"
     WHERE enabled = true
     ORDER BY "isDefault" DESC, "createdAt" ASC
     LIMIT 1`,
  );
  const device = printer.rows[0];
  if (!device) throw new Error('No enabled printer is saved.');
  if (device.connectionType !== 'RAW') throw new Error(`${device.name} is not a raw printer.`);
  if (!isPrivateIpv4(device.ipAddress)) throw new Error(`${device.name} does not have a private address.`);
  await sendTcp(device.ipAddress, device.port, slipBytes(lines), Number(process.env.PRINT_CONNECT_TIMEOUT_MS ?? 8000));
  console.log(`Sent ${lines.length} stays to ${device.name} (${device.ipAddress}:${device.port}).`);
} finally {
  await client.end();
}
