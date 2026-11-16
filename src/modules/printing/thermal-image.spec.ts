import { PNG } from 'pngjs';
import { pngToRaster } from './escpos';
import { composeSlip } from './slip';
import { printableDots } from './thermal-image';

function png(width: number, height: number, paint: (x: number, y: number) => [number, number, number, number]) {
  const image = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue, alpha] = paint(x, y);
      const index = (y * width + x) * 4;
      image.data[index] = red;
      image.data[index + 1] = green;
      image.data[index + 2] = blue;
      image.data[index + 3] = alpha;
    }
  }
  return PNG.sync.write(image);
}

function bit(bits: Uint8Array, width: number, x: number, y: number) {
  return (bits[y * (width / 8) + (x >> 3)] & (0x80 >> (x & 7))) !== 0;
}

function blackCount(bits: Uint8Array, width: number, x0: number, x1: number, height: number) {
  let count = 0;
  for (let y = 0; y < height; y += 1) for (let x = x0; x < x1; x += 1) if (bit(bits, width, x, y)) count += 1;
  return count;
}

describe('thermal printer profiles', () => {
  it('uses the Epson 203 DPI head widths and the configured resolution otherwise', () => {
    expect(printableDots(58, 203)).toBe(384);
    expect(printableDots(80, 203)).toBe(576);
    expect(printableDots(80, 300) % 8).toBe(0);
    expect(printableDots(80, 300)).toBeGreaterThan(576);
    expect(printableDots(58, 180)).toBeLessThan(384);
  });
});

describe('thermal image pipeline', () => {
  it('keeps black on the left, white on the right, and the original aspect', () => {
    const source = png(32, 16, (x) => (x < 16 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const printed = pngToRaster(source, 32, { mode: 'sharp' });
    expect(printed.width).toBe(32);
    expect(printed.height).toBe(16);
    expect(blackCount(printed.bits, 32, 0, 8, 16)).toBeGreaterThan(blackCount(printed.bits, 32, 24, 32, 16) * 4);
    const header = printed.escpos.subarray(0, 8);
    expect([...header]).toEqual([0x1d, 0x76, 0x30, 0x00, 4, 0, 16, 0]);
  });

  it('prints a transparent pixel as paper white, not black', () => {
    const source = png(16, 8, () => [0, 0, 0, 0]);
    const printed = pngToRaster(source, 16, { mode: 'sharp' });
    expect(blackCount(printed.bits, 16, 0, 16, printed.height)).toBe(0);
  });

  it('keeps a small icon and a QR-style grid readable', () => {
    const icon = png(16, 16, (x, y) => (x >= 4 && x < 12 && y >= 4 && y < 12 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const drawn = pngToRaster(icon, 32, { mode: 'sharp' });
    expect(bit(drawn.bits, 32, 16, Math.floor(drawn.height / 2))).toBe(true);
    expect(bit(drawn.bits, 32, 1, 1)).toBe(false);

    const qr = png(24, 24, (x, y) => ((Math.floor(x / 3) + Math.floor(y / 3)) % 2 === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const modules = pngToRaster(qr, 48, { mode: 'sharp' });
    const dark = blackCount(modules.bits, 48, 0, 48, modules.height);
    expect(dark).toBeGreaterThan(48 * modules.height * 0.3);
    expect(dark).toBeLessThan(48 * modules.height * 0.7);
  });

  it('keeps a faint signature stroke and dithers a photograph', () => {
    const signature = png(48, 24, (x, y) => (y > 8 && y < 14 && x > 6 && x < 40 ? [150, 150, 150, 255] : [255, 255, 255, 255]));
    const signed = pngToRaster(signature, 48, { mode: 'strokes' });
    expect(blackCount(signed.bits, 48, 8, 40, signed.height)).toBeGreaterThan(10);
    expect(blackCount(signed.bits, 48, 0, 4, signed.height)).toBe(0);

    const photo = png(32, 32, (x) => {
      const tone = Math.round((x / 31) * 255);
      return [tone, tone, tone, 255];
    });
    const dithered = pngToRaster(photo, 32, { mode: 'photo' });
    const ink = blackCount(dithered.bits, 32, 0, 32, dithered.height);
    expect(dithered.mode).toBe('photo');
    expect(ink).toBeGreaterThan(32 * dithered.height * 0.2);
    expect(ink).toBeLessThan(32 * dithered.height * 0.8);
  });

  it('fits the same artwork to 58mm and 80mm heads without clipping the width', () => {
    const logo = png(80, 40, (x, y) => (x < 4 || y < 2 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    for (const paper of [58, 80]) {
      const dots = printableDots(paper, 203);
      const printed = pngToRaster(logo, Math.round(dots * 0.66));
      expect(printed.width % 8).toBe(0);
      expect(printed.width).toBeLessThanOrEqual(dots);
      expect(printed.height).toBe(Math.round(40 * (printed.width / 80)));
      expect(blackCount(printed.bits, printed.width, 0, 8, Math.min(4, printed.height))).toBeGreaterThan(0);
    }
  });
});

describe('slip images', () => {
  it('prints the logo as GS v 0 and the words as text on both paper widths', () => {
    const logo = png(32, 32, (x, y) => ((x + y) % 2 === 0 ? [10, 10, 10, 255] : [250, 250, 250, 255]));
    const signature = png(40, 16, (x, y) => (y > 6 && y < 10 ? [90, 90, 90, 255] : [255, 255, 255, 0]));
    for (const paper of [58, 80]) {
      const slip = composeSlip({
        title: 'Restaurant receipt',
        restaurantName: 'Table & Thyme',
        location: 'Table 4',
        printedAt: '1 Nov 2026',
        lines: [{ left: 'Fine text line', right: '12 THB' }],
        total: '12 THB',
        rows: [{ left: 'Payment', right: 'Cash' }],
        footer: 'Thank you',
        logoImage: `data:image/png;base64,${logo.toString('base64')}`,
        signatureImage: `data:image/png;base64,${signature.toString('base64')}`,
        signatureLabel: 'Guest signature',
        signatureName: 'Avery',
      }, paper, 203);
      expect(slip.escpos.includes(Buffer.from('Fine text line'))).toBe(true);
      const images = slip.escpos.filter((byte, index, data) => data[index] === 0x1d && data[index + 1] === 0x76 && data[index + 2] === 0x30);
      expect(images.length).toBeGreaterThanOrEqual(2);
      expect(slip.columns).toBe(paper === 58 ? 32 : 48);
    }
  });
});
