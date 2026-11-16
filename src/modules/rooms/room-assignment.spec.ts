import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCloudbedsReservation, reservationImportAction } from './cloudbeds-email';
import { planImportedRoom, planRoomAssignment, preserveAssignedRoom, suggestedRoomNumbers, UNASSIGNED_MANUAL_SELECTION_REQUIRED, type AssignableRoom } from './room-assignment';

const html = readFileSync(join(__dirname, 'fixtures', 'cloudbeds-confirmed.html'), 'utf8');
const inventory: AssignableRoom[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', 'Family suite'].map((roomNumber) => ({ roomNumber, status: 'AVAILABLE' }));

function plan(roomType: string, occupied: string[] = []) {
  return planRoomAssignment({ roomType, inventory, occupiedRoomNumbers: occupied });
}

describe('imported reservation room assignment', () => {
  it('assigns the parsed Superior Queen booking to room 3', () => {
    const subject = /Subject:\s*([^<]+)/i.exec(html)?.[1] ?? '';
    const reservation = parseCloudbedsReservation({ subject, html });
    expect(plan(reservation?.roomType ?? '')).toEqual({ roomNumber: '3', reason: null });
  });

  it('assigns the other single-room types and leaves choice rooms unassigned', () => {
    expect(plan('Deluxe Room')).toEqual({ roomNumber: '2', reason: null });
    expect(plan('Deluxe Double Room')).toEqual({ roomNumber: '1', reason: null });
    expect(plan('Standard Bungalow')).toEqual({ roomNumber: null, reason: UNASSIGNED_MANUAL_SELECTION_REQUIRED });
    expect(plan('Double room with terrace')).toEqual({ roomNumber: null, reason: UNASSIGNED_MANUAL_SELECTION_REQUIRED });
    expect(plan('Family suite')).toEqual({ roomNumber: null, reason: UNASSIGNED_MANUAL_SELECTION_REQUIRED });
  });

  it('leaves a single room unassigned when it is already booked or unknown', () => {
    expect(plan('Superior Queen', ['3'])).toEqual({ roomNumber: null, reason: 'UNASSIGNED_OCCUPIED' });
    expect(plan('Penthouse')).toEqual({ roomNumber: null, reason: 'UNASSIGNED_NO_MATCH' });
    expect(planRoomAssignment({ roomType: 'Superior Queen', inventory: inventory.filter((room) => room.roomNumber !== '3'), occupiedRoomNumbers: [] })).toEqual({ roomNumber: null, reason: 'UNASSIGNED_NO_MATCH' });
  });

  it('does not create a duplicate and keeps a manual room', () => {
    expect(reservationImportAction('confirmed', true)).toBe('duplicate');
    expect(preserveAssignedRoom('manual-room', plan('Deluxe Room').roomNumber)).toBe('manual-room');
    expect(suggestedRoomNumbers('Superior Queen (Standard Rate)')).toEqual(['3']);
    expect(suggestedRoomNumbers('Standard Bungalow')).toEqual(['5', '9', '10']);
    expect(suggestedRoomNumbers('Double room with terrace')).toEqual(['12', '13', '14', '15']);
    expect(preserveAssignedRoom(null, '2')).toBe('2');
  });

  it('keeps a manual room on a new date range only when that room is still valid', () => {
    expect(planImportedRoom({ roomType: 'Deluxe Room', inventory, occupiedRoomNumbers: [], currentRoomNumber: '2', currentStatus: 'AVAILABLE' })).toEqual({ roomNumber: '2', reason: null, needsReview: false });
    expect(planImportedRoom({ roomType: 'Deluxe Room', inventory, occupiedRoomNumbers: ['2'], currentRoomNumber: '2', currentStatus: 'AVAILABLE' })).toEqual({ roomNumber: null, reason: 'UNASSIGNED_OCCUPIED', needsReview: true });
    expect(planImportedRoom({ roomType: 'Superior Queen', inventory, occupiedRoomNumbers: [], currentRoomNumber: '2', currentStatus: 'AVAILABLE' })).toEqual({ roomNumber: null, reason: 'UNASSIGNED_NO_MATCH', needsReview: true });
    expect(planImportedRoom({ roomType: 'Standard Bungalow', inventory, occupiedRoomNumbers: [], currentRoomNumber: '5', currentStatus: 'AVAILABLE' })).toEqual({ roomNumber: '5', reason: null, needsReview: false });
    expect(planImportedRoom({ roomType: 'Standard Bungalow', inventory, occupiedRoomNumbers: [], currentRoomNumber: null, currentStatus: null })).toEqual({ roomNumber: null, reason: UNASSIGNED_MANUAL_SELECTION_REQUIRED, needsReview: false });
    expect(planImportedRoom({ roomType: 'Double room with terrace', inventory, occupiedRoomNumbers: [], currentRoomNumber: null, currentStatus: null }).roomNumber).toBeNull();
  });
});
