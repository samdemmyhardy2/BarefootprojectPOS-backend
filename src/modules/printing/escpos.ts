import { deflateSync } from 'node:zlib';
import { connect as connectTcp } from 'node:net';
import { rasterizePng, type ThermalMode } from './thermal-image';

/** Turn a receipt image into an ESC/POS raster. Pale backgrounds stay blank. */
export function pngToEscPos(png: Buffer, targetWidth = 576) {
  const image = rasterizePng(png, targetWidth, { maxSource: 20000 });
  return { width: image.width, height: image.height, png: encodePng(image.bits, image.width, image.height), escpos: rasterToEscPos(image.bits, image.width, image.height, 8) };
}

/** Raster a logo, QR, icon, signature, or photo. Text stays ESC/POS text. */
export function pngToRaster(png: Buffer, targetWidth: number, options?: { threshold?: number; thicken?: boolean; mode?: ThermalMode }) {
  const mode = options?.mode ?? (options?.thicken ? 'strokes' : 'auto');
  const image = rasterizePng(png, targetWidth, { mode, maxSource: 2500 });
  return { width: image.width, height: image.height, bits: image.bits, mode: image.mode, escpos: rasterBands(image.bits, image.width, image.height) };
}

/** GS v 0 bands with no reset and no cut, so they can sit between text lines. */
export function rasterBands(bits: Uint8Array, width: number, height: number) {
  if (width % 8 !== 0) throw new Error('Raster width must be a multiple of 8 dots');
  const bytesPerRow = width / 8;
  if (bits.length !== bytesPerRow * height) throw new Error('Raster size does not match the image dimensions');
  const parts: Buffer[] = [];
  const band = 512;
  for (let y = 0; y < height; y += band) {
    const rows = Math.min(band, height - y);
    const slice = bits.subarray(y * bytesPerRow, (y + rows) * bytesPerRow);
    parts.push(Buffer.from([
      0x1d, 0x76, 0x30, 0x00,
      bytesPerRow & 0xff, (bytesPerRow >> 8) & 0xff,
      rows & 0xff, (rows >> 8) & 0xff,
    ]), Buffer.from(slice));
  }
  return Buffer.concat(parts);
}

/** Pack a 1-bit image, MSB first, 1 = black. Width must be divisible by 8. */
export function rasterToEscPos(bits: Uint8Array, width: number, height: number, density?: number) {
  const parts: Buffer[] = [Buffer.from([0x1b, 0x40])];
  if (density != null) parts.push(Buffer.from([0x1d, 0x28, 0x4b, 0x02, 0x00, 0x31, density & 0xff]));
  parts.push(rasterBands(bits, width, height), Buffer.from([0x1b, 0x64, 0x04, 0x1d, 0x56, 0x42, 0x00]));
  return Buffer.concat(parts);
}

export function encodePng(bits: Uint8Array, width: number, height: number) {
  const bytesPerRow = width / 8;
  const raw = Buffer.alloc((bytesPerRow + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (bytesPerRow + 1);
    raw[row] = 0;
    bits.subarray(y * bytesPerRow, (y + 1) * bytesPerRow).forEach((value, index) => {
      raw[row + 1 + index] = value ^ 0xff;
    });
  }
  const compressed = deflateSync(raw);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 1;
  ihdr[9] = 0;
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([length, body, crc]);
}

function crc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return crc ^ 0xffffffff;
}

export function checkTcp(host: string, port: number, timeoutMs: number) {
  return new Promise<{ reachable: boolean; error?: string }>((resolve) => {
    const socket = connectTcp({ host, port });
    let settled = false;
    const finish = (reachable: boolean, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ reachable, error });
    };
    const timer = setTimeout(() => finish(false, 'Connection timed out'), timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', (error) => finish(false, error.message));
  });
}

/** Write a complete payload, then close. Success means the socket accepted the bytes, not that paper moved. */
export function sendTcp(host: string, port: number, payload: Buffer, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const socket = connectTcp({ host, port });
    let settled = false;
    const fail = (error: Error) => {
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
