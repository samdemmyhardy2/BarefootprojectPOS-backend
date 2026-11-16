export const UNASSIGNED_MANUAL_SELECTION_REQUIRED = 'UNASSIGNED_MANUAL_SELECTION_REQUIRED';

type RoomRule = { key: string; numbers: string[]; manual: boolean };

/** Room numbers from the current calendar, not database ids. */
const ROOM_RULES: RoomRule[] = [
  { key: 'deluxe double room', numbers: ['1'], manual: false },
  { key: 'deluxe bungalow with sea view', numbers: ['4'], manual: false },
  { key: 'deluxe room', numbers: ['2'], manual: false },
  { key: 'superior queen', numbers: ['3'], manual: false },
  { key: 'standard bungalow', numbers: ['5', '9', '10'], manual: true },
  { key: 'superior bungalow', numbers: ['8'], manual: false },
  { key: 'double room with terrace', numbers: ['12', '13', '14', '15'], manual: true },
  { key: 'villa no6', numbers: ['6'], manual: false },
  { key: 'villa no7', numbers: ['7'], manual: false },
  { key: 'villa no11', numbers: ['11'], manual: false },
  { key: 'family suite', numbers: [], manual: true },
].sort((left, right) => right.key.length - left.key.length);

export type AssignableRoom = { roomNumber: string; status: string };

/** A room already chosen by staff stays put when the same booking is imported again. */
export function preserveAssignedRoom(existingRoomId: string | null, plannedRoomId: string | null) {
  return existingRoomId ?? plannedRoomId;
}

/** Keep a manual assignment only when that room still matches the type and is free. Never substitute a different room. */
export function planImportedRoom(input: { roomType: string | null; inventory: AssignableRoom[]; occupiedRoomNumbers: string[]; currentRoomNumber: string | null; currentStatus: string | null }) {
  if (input.currentRoomNumber) {
    const unavailable = input.currentStatus === 'MAINTENANCE' || input.currentStatus === 'ARCHIVED';
    const occupied = input.occupiedRoomNumbers.some((number) => sameRoomNumber(number, input.currentRoomNumber!));
    const rule = matchRoomRule(input.roomType);
    const fits = Boolean(rule && rule.numbers.some((number) => sameRoomNumber(number, input.currentRoomNumber!)));
    if (!unavailable && !occupied && fits) return { roomNumber: input.currentRoomNumber, reason: null as string | null, needsReview: false };
    const reason = unavailable ? 'UNASSIGNED_UNAVAILABLE' : occupied ? 'UNASSIGNED_OCCUPIED' : 'UNASSIGNED_NO_MATCH';
    return { roomNumber: null, reason, needsReview: true };
  }
  const plan = planRoomAssignment(input);
  return { roomNumber: plan.roomNumber, reason: plan.reason, needsReview: false };
}

export function planRoomAssignment(input: { roomType: string | null; inventory: AssignableRoom[]; occupiedRoomNumbers: string[] }) {
  const rule = matchRoomRule(input.roomType);
  if (!rule) return { roomNumber: null as string | null, reason: 'UNASSIGNED_NO_MATCH' };
  if (rule.manual || rule.numbers.length !== 1) return { roomNumber: null, reason: UNASSIGNED_MANUAL_SELECTION_REQUIRED };
  const matches = input.inventory.filter((room) => sameRoomNumber(room.roomNumber, rule.numbers[0]));
  if (matches.length !== 1) return { roomNumber: null, reason: 'UNASSIGNED_NO_MATCH' };
  const room = matches[0];
  if (room.status === 'MAINTENANCE' || room.status === 'ARCHIVED') return { roomNumber: null, reason: 'UNASSIGNED_UNAVAILABLE' };
  if (input.occupiedRoomNumbers.some((number) => sameRoomNumber(number, room.roomNumber))) return { roomNumber: null, reason: 'UNASSIGNED_OCCUPIED' };
  return { roomNumber: room.roomNumber, reason: null };
}

export function suggestedRoomNumbers(roomType: string | null) {
  return matchRoomRule(roomType)?.numbers ?? [];
}

export function matchRoomRule(roomType: string | null) {
  const normalized = normalizeRoomType(roomType ?? '');
  if (!normalized) return null;
  return ROOM_RULES.find((rule) => normalized === rule.key || normalized.startsWith(`${rule.key} `)) ?? null;
}

export function sameRoomNumber(left: string, right: string) {
  return roomKey(left) === roomKey(right);
}

function normalizeRoomType(value: string) {
  return value.toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\bno\.?\s*(\d+)/g, 'no$1')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function roomKey(value: string) {
  return value.trim().toLowerCase().replace(/^room\s+/, '');
}
