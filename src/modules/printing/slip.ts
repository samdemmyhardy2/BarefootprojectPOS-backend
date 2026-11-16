import { pngToRaster } from './escpos';
import { renderStoreTitle } from './store-title';
import { printableDots } from './thermal-image';

export type SlipRow = { left: string; right?: string; note?: string };

export type SlipInput = {
  title: string;
  restaurantName: string;
  location?: string;
  printedAt: string;
  lines: SlipRow[];
  vat?: SlipRow;
  total: string;
  rows: SlipRow[];
  signatureLabel?: string;
  signatureName?: string;
  signatureNote?: string;
  signatureImage?: string;
  logoImage?: string;
  footer: string;
};

export function composeSlip(input: SlipInput, paperWidthMm = 80, dpi = 203) {
  const columns = paperWidthMm <= 58 ? 32 : 48;
  const dots = printableDots(paperWidthMm, dpi);
  const parts: Buffer[] = [
    Buffer.from([0x1b, 0x40]),
    Buffer.from([0x1d, 0x28, 0x4b, 0x02, 0x00, 0x31, 0x08]),
    Buffer.from([0x1c, 0x28, 0x43, 0x02, 0x00, 0x30, 0x02]),
    Buffer.from([0x1b, 0x4d, 0x00]),
    Buffer.from([0x1b, 0x47, 0x01]),
    align(1),
    bold(true),
    size(1, 1),
  ];
  const logo = rasterImage(input.logoImage, alignDots(Math.round(dots * 0.66)), false);
  if (logo) parts.push(logo, Buffer.from([0x0a]));
  parts.push(textLine(input.title.toUpperCase(), columns));
  const storeTitle = renderStoreTitle(input.restaurantName, alignDots(Math.max(16, dots - 32)), paperWidthMm <= 58 ? 46 : 52);
  if (storeTitle) parts.push(storeTitle.escpos, Buffer.from([0x0a]));
  else parts.push(size(2, 2), textLine(input.restaurantName, Math.floor(columns / 2)), size(1, 1));
  if (input.location) parts.push(textLine(input.location, columns));
  parts.push(textLine(input.printedAt, columns), align(0), bold(false), rule(columns));
  for (const line of input.lines) {
    parts.push(bold(Boolean(line.right) && !line.left.startsWith(' ')));
    pair(line.left, line.right ?? '', columns).forEach((row) => parts.push(textLine(row, columns)));
    parts.push(bold(false));
    if (line.note) wrap(`  ${line.note}`, columns).forEach((row) => parts.push(textLine(row, columns)));
  }
  parts.push(rule(columns), bold(false), size(1, 1));
  if (input.vat) pair(input.vat.left, input.vat.right ?? '', columns).forEach((row) => parts.push(textLine(row, columns)));
  parts.push(bold(true), size(1, 2));
  pair('Total', input.total, columns).forEach((row) => parts.push(textLine(row, columns)));
  parts.push(size(1, 1), bold(false));
  for (const row of input.rows) pair(row.left, row.right ?? '', columns).forEach((line) => parts.push(textLine(line, columns)));
  if (input.signatureLabel || input.signatureImage) {
    parts.push(rule(columns), align(1), bold(true));
    if (input.signatureLabel) parts.push(textLine(input.signatureLabel, columns));
    parts.push(bold(false));
    const signature = rasterImage(input.signatureImage, alignDots(Math.round(dots * 0.82)), true);
    if (signature) parts.push(signature, Buffer.from([0x0a]));
    if (input.signatureName) parts.push(textLine(input.signatureName, columns));
    if (input.signatureNote) wrap(input.signatureNote, columns).forEach((row) => parts.push(textLine(row, columns)));
  }
  parts.push(align(1), bold(true), textLine(input.footer, columns), Buffer.from([0x1b, 0x64, 0x04, 0x1d, 0x56, 0x42, 0x00]));
  return { columns, escpos: Buffer.concat(parts), html: slipHtml(input) };
}

function alignDots(dots: number) {
  return Math.max(8, dots - (dots % 8));
}

function rasterImage(value: string | undefined, dots: number, thicken: boolean) {
  const png = readPng(value);
  if (!png) return null;
  try {
    return pngToRaster(png, dots, { threshold: thicken ? 170 : 145, thicken }).escpos;
  } catch {
    return null;
  }
}

function readPng(value?: string) {
  if (!value) return null;
  const base64 = value.replace(/^data:image\/png;base64,/i, '').trim();
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length < 8 || buffer[0] !== 0x89 || buffer[1] !== 0x50) return null;
  return buffer;
}

function align(mode: 0 | 1 | 2) {
  return Buffer.from([0x1b, 0x61, mode]);
}

function bold(on: boolean) {
  return Buffer.from([0x1b, 0x45, on ? 1 : 0]);
}

function size(width: number, height: number) {
  return Buffer.from([0x1d, 0x21, ((width - 1) << 4) | (height - 1)]);
}

function textLine(value: string, columns: number) {
  const lines = wrap(value, columns);
  return Buffer.concat((lines.length ? lines : ['']).map((line) => Buffer.concat([Buffer.from(clean(line), 'utf8'), Buffer.from([0x0a])])));
}

function rule(columns: number) {
  return textLine('-'.repeat(columns), columns);
}

function pair(left: string, right: string, columns: number) {
  const rightText = clean(right).trim();
  const rawLeft = clean(left).replace(/\s+$/g, '');
  const indent = rawLeft.startsWith('  ') ? '  ' : '';
  const leftText = `${indent}${rawLeft.trim()}`;
  if (!rightText) return wrap(leftText, columns);
  const room = Math.max(1, columns - widthOf(rightText) - 1);
  const first = take(leftText, room);
  const rest = leftText.slice(first.length).trim();
  const gap = Math.max(1, columns - widthOf(first) - widthOf(rightText));
  return [first + ' '.repeat(gap) + rightText, ...wrap(rest, columns)];
}

function wrap(value: string, columns: number) {
  const raw = clean(value).replace(/\s+$/g, '');
  const text = raw.startsWith('  ') ? `  ${raw.trim()}` : raw.trim();
  if (!text) return [];
  const lines: string[] = [];
  let rest = text;
  while (rest) {
    if (widthOf(rest) <= columns) {
      lines.push(rest);
      break;
    }
    let cut = take(rest, columns);
    const space = cut.lastIndexOf(' ');
    if (space > 8) cut = cut.slice(0, space);
    lines.push(cut);
    rest = rest.slice(cut.length).trim();
  }
  return lines;
}

function take(value: string, columns: number) {
  let result = '';
  let used = 0;
  for (const character of value) {
    const size = widthOf(character);
    if (used + size > columns) break;
    result += character;
    used += size;
  }
  return result || value.slice(0, 1);
}

function widthOf(value: string) {
  let width = 0;
  for (const character of value) width += character.charCodeAt(0) > 255 ? 2 : 1;
  return width;
}

function clean(value: string) {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ');
}

function slipHtml(input: SlipInput) {
  const row = (line: SlipRow) => `<div class="row"><span>${escapeHtml(line.left)}</span>${line.right ? `<span>${escapeHtml(line.right)}</span>` : ''}</div>${line.note ? `<p class="note">${escapeHtml(line.note)}</p>` : ''}`;
  const logo = imageSrc(input.logoImage);
  const signature = imageSrc(input.signatureImage);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;background:#fff;color:#000}
    article{width:72mm;margin:0 auto;padding:4mm 3mm 8mm;font-family:Arial,Helvetica,sans-serif;font-weight:700;color:#000;font-size:14px;line-height:1.35}
    img.logo{display:block;margin:0 auto 8px;max-width:34mm;height:auto}
    h1{margin:2px 0 6px;text-align:center;font-family:Inter,"Segoe UI",Arial,sans-serif;font-size:28px;font-weight:700;line-height:1.05}
    .center{text-align:center;margin:0}
    .kicker{text-align:center;font-size:12px;letter-spacing:.12em;margin:0 0 4px}
    .rule{border-top:2px solid #000;margin:8px 0}
    .row{display:flex;justify-content:space-between;gap:10px;margin:3px 0}
    .note{margin:0 0 4px 12px;font-size:12px}
    .total{font-size:20px}
    img.sign{display:block;margin:6px auto;max-width:58mm;max-height:28mm;object-fit:contain}
  </style></head><body><article>
    ${logo ? `<img class="logo" alt="" src="${logo}">` : ''}
    <p class="kicker">${escapeHtml(input.title.toUpperCase())}</p>
    <h1>${escapeHtml(input.restaurantName)}</h1>
    ${input.location ? `<p class="center">${escapeHtml(input.location)}</p>` : ''}
    <p class="center">${escapeHtml(input.printedAt)}</p>
    <div class="rule"></div>
    ${input.lines.map(row).join('')}
    <div class="rule"></div>
    ${input.vat ? row(input.vat) : ''}
    <div class="row total"><span>Total</span><span>${escapeHtml(input.total)}</span></div>
    ${input.rows.map(row).join('')}
    ${input.signatureLabel || signature ? `<div class="rule"></div><p class="center">${escapeHtml(input.signatureLabel ?? '')}</p>${signature ? `<img class="sign" alt="Signature" src="${signature}">` : ''}${input.signatureName ? `<p class="center">${escapeHtml(input.signatureName)}</p>` : ''}${input.signatureNote ? `<p class="center note">${escapeHtml(input.signatureNote)}</p>` : ''}` : ''}
    <p class="center">${escapeHtml(input.footer)}</p>
  </article></body></html>`;
}

function imageSrc(value?: string) {
  if (!value) return '';
  const trimmed = value.trim();
  return /^data:image\/png;base64,[a-z0-9+/=\r\n]+$/i.test(trimmed) ? trimmed : '';
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] ?? character));
}
