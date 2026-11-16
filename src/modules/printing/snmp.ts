import { createSocket } from 'node:dgram';

const PRINTER_OIDS = [
  '1.3.6.1.2.1.1.1.0',
  '1.3.6.1.2.1.1.5.0',
  '1.3.6.1.2.1.25.3.2.1.3.1',
  '1.3.6.1.2.1.43.5.1.1.16.1',
  '1.3.6.1.2.1.43.5.1.1.17.1',
];

export function snmpGetPacket(oids = PRINTER_OIDS, requestId = 1) {
  const varbinds = Buffer.concat(oids.map((oid) => sequence(Buffer.concat([oidTag(oid), Buffer.from([0x05, 0x00])]))));
  const pdu = tlv(0xa0, Buffer.concat([
    integer(requestId),
    integer(0),
    integer(0),
    sequence(varbinds),
  ]));
  return sequence(Buffer.concat([integer(1), tlv(0x04, Buffer.from('public')), pdu]));
}

export function snmpText(packet: Buffer) {
  const parts: string[] = [];
  for (let index = 0; index < packet.length - 2; index += 1) {
    if (packet[index] !== 0x04) continue;
    const [length, offset] = readLength(packet, index + 1);
    const end = offset + length;
    if (end > packet.length || length < 2 || length > 240) continue;
    const text = packet.subarray(offset, end).toString('utf8').replace(/[^\x20-\x7e]/g, ' ').trim();
    if (text.length >= 2) parts.push(text);
    index = end - 1;
  }
  return parts.join(' ');
}

export function querySnmp(ip: string, timeoutMs: number) {
  return new Promise<string>((resolve) => {
    const socket = createSocket('udp4');
    const packet = snmpGetPacket();
    let settled = false;
    const finish = (text: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      resolve(text);
    };
    const timer = setTimeout(() => finish(''), timeoutMs);
    socket.once('error', () => finish(''));
    socket.once('message', (message) => finish(snmpText(message)));
    socket.send(packet, 161, ip, (error) => { if (error) finish(''); });
  });
}

function sequence(value: Buffer) { return tlv(0x30, value); }

function integer(value: number) {
  const bytes: number[] = [];
  let current = value;
  do { bytes.unshift(current & 0xff); current >>= 8; } while (current > 0);
  if (bytes[0] & 0x80) bytes.unshift(0);
  return tlv(0x02, Buffer.from(bytes));
}

function oidTag(oid: string) {
  const parts = oid.split('.').map(Number);
  const bytes = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const encoded: number[] = [part & 0x7f];
    let rest = part >> 7;
    while (rest > 0) { encoded.unshift((rest & 0x7f) | 0x80); rest >>= 7; }
    bytes.push(...encoded);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function tlv(tag: number, value: Buffer) {
  return Buffer.concat([Buffer.from([tag]), length(value.length), value]);
}

function length(value: number) {
  if (value < 128) return Buffer.from([value]);
  const bytes: number[] = [];
  let current = value;
  while (current > 0) { bytes.unshift(current & 0xff); current >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function readLength(packet: Buffer, offset: number): [number, number] {
  const first = packet[offset];
  if (first < 128) return [first, offset + 1];
  const count = first & 0x7f;
  let size = 0;
  for (let index = 0; index < count; index += 1) size = (size << 8) | packet[offset + 1 + index];
  return [size, offset + 1 + count];
}
