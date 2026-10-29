import { BadGatewayException, BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { RoomsService } from './rooms.service';
import { SAMPLE_ROOMS, sampleStays } from './sample-calendar';

const CLOUDBEDS_API = 'https://api.cloudbeds.com/api/v1.3';

type CloudbedsEnvelope<T> = { success?: boolean; message?: string | null; data?: T; total?: number };

type CloudbedsRoom = { roomID: string; roomName: string; roomTypeID: string; roomTypeName: string };
type CloudbedsReservationRoom = {
  subReservationID?: string;
  roomID?: string | null;
  roomName?: string | null;
  roomTypeName?: string;
  guestName?: string;
  adults?: string;
  children?: string;
  roomCheckIn?: string;
  roomCheckOut?: string;
  roomStatus?: 'cancelled' | 'in_house' | 'checked_out' | 'not_checked_in';
};
type CloudbedsReservation = {
  reservationID: string;
  status: string;
  guestName?: string;
  startDate?: string;
  endDate?: string;
  adults?: string;
  children?: string;
  balance?: number;
  sourceName?: string;
  rooms?: CloudbedsReservationRoom[];
};

export type CloudbedsCalendarStay = {
  reservationID: string;
  subReservationID: string | null;
  roomID: string | null;
  roomName: string | null;
  guestName: string;
  startDate: string;
  endDate: string;
  status: string;
  roomStatus: string;
  adults: string;
  children: string;
  balance: number;
  sourceName: string;
  tone?: string;
  arriveTime?: string;
  leaveTime?: string;
};

@Injectable()
export class CloudbedsService {
  private readonly sampleStatus = new Map<string, string>();

  constructor(private readonly rooms: RoomsService) {}

  configured() {
    return Boolean(process.env.CLOUDBEDS_API_KEY?.trim());
  }

  async calendar(from: string, to: string) {
    if (!this.configured()) {
      this.assertRange(from, to);
      return {
        configured: false as const,
        from,
        to,
        propertyID: null,
        rooms: SAMPLE_ROOMS,
        stays: sampleStays(from, to, (reservationID) => this.sampleStatus.get(reservationID)),
      };
    }
    this.assertRange(from, to);
    const propertyID = process.env.CLOUDBEDS_PROPERTY_ID?.trim() || undefined;
    const [roomPages, reservations] = await Promise.all([
      this.pages<{ propertyID: string; rooms: CloudbedsRoom[] }>('getRooms', { propertyIDs: propertyID, pageSize: 100, sort: 'room_position:asc' }),
      this.pages<CloudbedsReservation>('getReservations', {
        propertyID,
        datesQueryMode: 'rooms',
        checkInTo: to,
        checkOutFrom: from,
        includeAllRooms: true,
        pageSize: 100,
      }),
    ]);
    const rooms = roomPages.flatMap((property) => property.rooms ?? []).filter((room) => room.roomID && room.roomName);
    const stays = reservations
      .filter((reservation) => reservation.status !== 'canceled' && reservation.status !== 'no_show')
      .flatMap((reservation) => this.staysFor(reservation))
      .filter((stay) => stay.startDate < to && stay.endDate > from);
    return { configured: true as const, from, to, propertyID: propertyID ?? roomPages[0]?.propertyID ?? null, rooms, stays };
  }

  async checkIn(dto: { reservationID: string; subReservationID?: string; roomID?: string; roomName?: string; guestName?: string; checkOut?: string }) {
    if (!this.configured()) return this.sampleAction(dto.reservationID, 'in_house');
    await this.post('postRoomCheckIn', {
      propertyID: process.env.CLOUDBEDS_PROPERTY_ID?.trim(),
      reservationID: dto.reservationID,
      subReservationID: dto.subReservationID,
      roomID: dto.subReservationID ? undefined : dto.roomID,
    });
    return { success: true, folio: await this.openFolio(dto) };
  }

  async checkOut(dto: { reservationID: string; subReservationID?: string; roomID?: string; roomName?: string }) {
    if (!this.configured()) return this.sampleAction(dto.reservationID, 'checked_out');
    await this.post('postRoomCheckOut', {
      propertyID: process.env.CLOUDBEDS_PROPERTY_ID?.trim(),
      reservationID: dto.reservationID,
      subReservationID: dto.subReservationID,
      roomID: dto.subReservationID ? undefined : dto.roomID,
    });
    return { success: true, folio: await this.closeFolio(dto.roomName) };
  }

  private staysFor(reservation: CloudbedsReservation): CloudbedsCalendarStay[] {
    const rooms = reservation.rooms?.length ? reservation.rooms : [undefined];
    return rooms.flatMap((room) => {
      if (room?.roomStatus === 'cancelled') return [];
      const startDate = room?.roomCheckIn || reservation.startDate;
      const endDate = room?.roomCheckOut || reservation.endDate;
      if (!startDate || !endDate) return [];
      return [{
        reservationID: reservation.reservationID,
        subReservationID: room?.subReservationID ?? null,
        roomID: room?.roomID || null,
        roomName: room?.roomName || null,
        guestName: room?.guestName || reservation.guestName || 'Guest',
        startDate,
        endDate,
        status: reservation.status,
        roomStatus: room?.roomStatus || (reservation.status === 'checked_in' ? 'in_house' : reservation.status === 'checked_out' ? 'checked_out' : 'not_checked_in'),
        adults: room?.adults || reservation.adults || '0',
        children: room?.children || reservation.children || '0',
        balance: Number(reservation.balance ?? 0),
        sourceName: reservation.sourceName || '',
      }];
    });
  }

  private async openFolio(dto: { roomName?: string; guestName?: string; checkOut?: string }) {
    const roomName = dto.roomName?.trim();
    const guestName = dto.guestName?.trim();
    if (!roomName || !guestName) return { opened: false, warning: 'Cloudbeds checked the guest in. The restaurant folio was not opened because the room or guest name was missing.' };
    const match = (await this.rooms.findAll()).find((room) => room.roomNumber === roomName);
    if (!match) return { opened: false, warning: `Cloudbeds checked the guest in. No room named ${roomName} exists here, so the restaurant folio was not opened.` };
    if (match.status !== 'AVAILABLE') return { opened: false, warning: `Cloudbeds checked the guest in. Room ${roomName} already has an open folio.` };
    try {
      const stay = await this.rooms.checkIn(match.id, {
        primaryGuestName: guestName,
        occupants: [guestName],
        ...(dto.checkOut ? { expectedCheckoutAt: `${dto.checkOut}T12:00:00` } : {}),
      });
      const stayId = stay && typeof stay === 'object' && 'id' in stay && typeof stay.id === 'string' ? stay.id : null;
      return { opened: Boolean(stayId), stayId, warning: null };
    } catch (error) {
      return { opened: false, warning: error instanceof Error ? `Cloudbeds checked the guest in. ${error.message}` : 'Cloudbeds checked the guest in. The restaurant folio could not be opened.' };
    }
  }

  private async closeFolio(roomName?: string) {
    const name = roomName?.trim();
    if (!name) return { closed: false, warning: 'Cloudbeds checked the guest out. No matching restaurant folio was closed.' };
    const match = (await this.rooms.findAll()).find((room) => room.roomNumber === name);
    const stay = match?.stays?.[0];
    if (!match || !stay) return { closed: false, warning: 'Cloudbeds checked the guest out. This room has no open restaurant folio.' };
    try {
      await this.rooms.checkOut(stay.id);
      return { closed: true, warning: null };
    } catch (error) {
      return { closed: false, warning: error instanceof Error ? `Cloudbeds checked the guest out. ${error.message}` : 'Cloudbeds checked the guest out. The restaurant folio is still open.' };
    }
  }

  private async pages<T>(method: string, query: Record<string, string | number | boolean | undefined>) {
    const rows: T[] = [];
    for (let pageNumber = 1; pageNumber <= 20; pageNumber += 1) {
      const body = await this.get<T[]>(method, { ...query, pageNumber });
      const data = body.data ?? [];
      rows.push(...data);
      if (data.length < 100 || (body.total !== undefined && rows.length >= body.total)) break;
    }
    return rows;
  }

  private async get<T>(method: string, query: Record<string, string | number | boolean | undefined>) {
    const url = new URL(`${CLOUDBEDS_API}/${method}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }
    return this.request<T>(url, { headers: this.headers() });
  }

  private async post(method: string, fields: Record<string, string | undefined>) {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) if (value) body.set(key, value);
    await this.request(`${CLOUDBEDS_API}/${method}`, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  }

  private headers() {
    const key = process.env.CLOUDBEDS_API_KEY?.trim();
    if (!key) throw new ServiceUnavailableException('Cloudbeds is not connected. Add CLOUDBEDS_API_KEY on the server.');
    return { 'x-api-key': key, Accept: 'application/json' };
  }

  private async request<T>(url: string | URL, init: RequestInit) {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
    } catch {
      throw new BadGatewayException('Cloudbeds did not respond. Try the calendar again.');
    }
    const payload = await response.json().catch(() => null) as CloudbedsEnvelope<T> | null;
    if (!response.ok || payload?.success === false) {
      throw new BadGatewayException(payload?.message || 'Cloudbeds rejected the request.');
    }
    return payload ?? { data: undefined };
  }

  private sampleAction(reservationID: string, roomStatus: 'in_house' | 'checked_out') {
    if (!reservationID.startsWith('sample-')) {
      throw new ServiceUnavailableException('Cloudbeds is not connected. Add CLOUDBEDS_API_KEY on the server.');
    }
    this.sampleStatus.set(reservationID, roomStatus);
    return { success: true, folio: { opened: false, stayId: null, warning: null } };
  }

  private assertRange(from: string, to: string) {
    if (from > to) throw new BadRequestException('The calendar start date must be on or before the end date');
    if (this.daySpan(from, to) > 62) throw new BadRequestException('Choose a calendar range of 62 days or less');
  }

  private daySpan(from: string, to: string) {
    const [fromYear, fromMonth, fromDay] = from.split('-').map(Number);
    const [toYear, toMonth, toDay] = to.split('-').map(Number);
    return Math.round((Date.UTC(toYear, toMonth - 1, toDay) - Date.UTC(fromYear, fromMonth - 1, fromDay)) / 86400000);
  }
}
