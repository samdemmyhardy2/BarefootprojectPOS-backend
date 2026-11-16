import { glyphColumns } from './receipt-font';
import { encodePng, rasterToEscPos } from './escpos';
import { renderStoreTitle } from './store-title';
import { printableDots } from './thermal-image';

export type ReceiptLine = { name: string; quantity: number; detail: string; amount: string };

export type ReceiptDocument = {
  restaurantName: string;
  customerName: string;
  vip: boolean;
  printedAt: string;
  orderNumber: string;
  location: string;
  administrator: string;
  lines: ReceiptLine[];
  subtotal: string;
  vat?: string;
  vatLabel?: string;
  total: string;
  paymentMethod: string;
  paymentStatus: string;
  servedBy: string;
  collectedBy: string;
  processedBy: string;
  footer: string;
};

type DrawOp =
  | { kind: 'text'; text: string; align: 'left' | 'center' | 'right'; scale: number; invert?: boolean }
  | { kind: 'title'; text: string }
  | { kind: 'rule' }
  | { kind: 'gap'; px: number }
  | { kind: 'pair'; left: string; right: string; scale: number };

const CHAR_W = 6;
const CHAR_H = 8;

export function moneyLabel(value: number) {
  return `${new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value)} THB`;
}

export function dotsForPaper(paperWidthMm: number, dpi = 203) {
  return printableDots(paperWidthMm, dpi);
}

export function renderReceipt(document: ReceiptDocument, paperWidthMm = 80, dpi = 203) {
  const width = dotsForPaper(paperWidthMm, dpi);
  const ops = layout(document, width);
  const height = ops.reduce((sum, op) => sum + opHeight(op, width), 0) + 16;
  const bytesPerRow = width / 8;
  const bits = new Uint8Array(bytesPerRow * height);
  paintWatermark(bits, width, height, document.restaurantName);
  let y = 8;
  for (const op of ops) {
    paint(bits, width, y, op);
    y += opHeight(op, width);
  }
  return {
    width,
    height,
    png: encodePng(bits, width, height),
    escpos: rasterToEscPos(bits, width, height),
    html: receiptHtml(document),
  };
}

export function receiptHtml(document: ReceiptDocument) {
  const rows = document.lines.map((line) => `<div class="item"><div><span>${line.quantity} x ${escapeHtml(line.name)}</span>${line.detail ? `<small>${escapeHtml(line.detail)}</small>` : ''}</div><b>${escapeHtml(line.amount)}</b></div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;background:#f6f1ea;font-family:Georgia,serif;color:#241c18}
    article{width:80mm;margin:0 auto;padding:8mm 6mm;background:#fffdf8;position:relative;overflow:hidden}
    article:before{content:"${escapeHtml(document.restaurantName)}";position:absolute;inset:30% 0 auto;text-align:center;font-size:28px;letter-spacing:.2em;color:rgba(36,28,24,.06);transform:rotate(-18deg)}
    h1{margin:0;text-align:center;font-size:22px;letter-spacing:.04em}
    .badge{display:${document.vip ? 'inline-block' : 'none'};margin-top:6px;padding:2px 8px;border:1px solid #241c18;border-radius:99px;font-size:10px;letter-spacing:.14em}
    .meta,.pair{display:flex;justify-content:space-between;gap:8px;font-size:11px;margin-top:4px}
    .rule{border-top:1px dashed #241c18;margin:8px 0}
    .item{display:flex;justify-content:space-between;gap:8px;font-size:12px;margin:4px 0}
    small{display:block;color:#65584f;font-size:10px}
    .total{margin-top:8px;padding:8px;background:#241c18;color:#fffdf8;display:flex;justify-content:space-between;font-weight:700}
    footer{margin-top:12px;text-align:center;font-size:11px}
  </style></head><body><article>
    <h1>${escapeHtml(document.restaurantName)}</h1>
    <p style="text-align:center;margin:6px 0 0"><span class="badge">VIP</span></p>
    <p style="text-align:center;margin:4px 0 0;font-size:12px">${escapeHtml(document.customerName || 'Guest')}</p>
    <div class="rule"></div>
    <div class="meta"><span>${escapeHtml(document.printedAt)}</span><span>#${escapeHtml(document.orderNumber)}</span></div>
    <div class="pair"><span>${escapeHtml(document.location)}</span><span>${escapeHtml(document.administrator)}</span></div>
    <div class="rule"></div>
    ${rows}
    <div class="rule"></div>
    ${document.vat ? `<div class="pair"><span>${escapeHtml(document.vatLabel || 'VAT')}</span><b>${escapeHtml(document.vat)}</b></div>` : ''}
    <div class="total"><span>Total</span><span>${escapeHtml(document.total)}</span></div>
    <div class="pair"><span>${escapeHtml(document.paymentMethod)}</span><span>${escapeHtml(document.paymentStatus)}</span></div>
    <footer>${escapeHtml(document.footer)}</footer>
  </article></body></html>`;
}

function layout(document: ReceiptDocument, width: number): DrawOp[] {
  const scale = width >= 576 ? 2 : 1;
  const ops: DrawOp[] = [
    { kind: 'title', text: document.restaurantName },
    { kind: 'gap', px: 6 },
  ];
  if (document.vip) ops.push({ kind: 'text', text: 'VIP', align: 'center', scale });
  ops.push(
    { kind: 'text', text: document.customerName || 'Guest', align: 'center', scale },
    { kind: 'gap', px: 4 },
    { kind: 'rule' },
    { kind: 'pair', left: document.printedAt, right: `#${document.orderNumber}`, scale },
    { kind: 'pair', left: document.location, right: document.administrator, scale },
    { kind: 'rule' },
  );
  for (const line of document.lines) {
    ops.push({ kind: 'pair', left: `${line.quantity} x ${line.name}`, right: line.amount, scale });
    if (line.detail) ops.push({ kind: 'text', text: line.detail, align: 'left', scale: 1 });
  }
  ops.push(
    { kind: 'rule' },
    ...(document.vat ? [{ kind: 'pair' as const, left: document.vatLabel || 'VAT', right: document.vat, scale }] : []),
    { kind: 'text', text: `Total  ${document.total}`, align: 'center', scale: scale + 1, invert: true },
    { kind: 'pair', left: document.paymentMethod, right: document.paymentStatus, scale },
    { kind: 'gap', px: 8 },
    { kind: 'text', text: document.footer, align: 'center', scale },
  );
  return ops;
}

function opHeight(op: DrawOp, width = 576) {
  if (op.kind === 'gap') return op.px;
  if (op.kind === 'rule') return 8;
  if (op.kind === 'title') return (renderStoreTitle(op.text, Math.max(16, width - 16), width <= 420 ? 46 : 52)?.height ?? CHAR_H * 3) + 4;
  if (op.kind === 'pair') return Math.max(wrap(op.left, pairWidth(width, op.scale).left).length, wrap(op.right, pairWidth(width, op.scale).right).length) * (CHAR_H * op.scale + 2);
  return wrap(op.text, Math.max(8, Math.floor((width - 8) / (CHAR_W * op.scale)))).length * (CHAR_H * op.scale + 4);
}

function paint(bits: Uint8Array, width: number, y: number, op: DrawOp) {
  if (op.kind === 'rule') { hline(bits, width, y + 3); return; }
  if (op.kind === 'gap') return;
  if (op.kind === 'title') {
    const title = renderStoreTitle(op.text, Math.max(16, width - 16), width <= 420 ? 46 : 52);
    if (!title) {
      paint(bits, width, y, { kind: 'text', text: op.text, align: 'center', scale: width >= 576 ? 3 : 2 });
      return;
    }
    blit(bits, width, title.bits, title.width, Math.max(0, Math.floor((width - title.width) / 2)), y + 1);
    return;
  }
  if (op.kind === 'text') {
    const scale = op.scale;
    const lines = wrap(op.text, Math.max(8, Math.floor((width - 8) / (CHAR_W * scale))));
    lines.forEach((line, index) => {
      const textWidth = line.length * CHAR_W * scale;
      const x = op.align === 'center' ? Math.max(0, Math.floor((width - textWidth) / 2)) : op.align === 'right' ? Math.max(0, width - textWidth - 4) : 4;
      const lineY = y + index * (CHAR_H * scale + 4);
      if (op.invert) fillRect(bits, width, 0, lineY, width, CHAR_H * scale + 2, true);
      drawText(bits, width, line, x, lineY + 1, scale, !op.invert);
    });
    return;
  }
  const scale = op.scale;
  const columns = pairWidth(width, scale);
  const left = wrap(op.left, columns.left);
  const right = wrap(op.right, columns.right);
  const lineH = CHAR_H * scale + 2;
  left.forEach((line, index) => drawText(bits, width, line, 4, y + index * lineH, scale, true));
  right.forEach((line, index) => drawText(bits, width, line, width - line.length * CHAR_W * scale - 4, y + index * lineH, scale, true));
}

function pairWidth(width: number, scale: number) {
  const max = Math.max(12, Math.floor(width / (CHAR_W * scale)) - 1);
  return { left: Math.max(8, Math.floor(max * 0.68)), right: Math.max(6, max - Math.floor(max * 0.68) - 1) };
}

function paintWatermark(bits: Uint8Array, width: number, height: number, name: string) {
  const text = name.toUpperCase().replace(/[^A-Z0-9 &]/g, '').slice(0, 18) || 'TABLE THYME';
  const scale = 3;
  const x = Math.max(8, Math.floor((width - text.length * CHAR_W * scale) / 2));
  const y = Math.floor(height * 0.42);
  for (let i = 0; i < text.length; i += 1) {
    glyphColumns(text[i]).forEach((column, cx) => {
      for (let cy = 0; cy < 7; cy += 1) {
        if (((column >> cy) & 1) === 0) continue;
        for (let sy = 0; sy < scale; sy += 1) for (let sx = 0; sx < scale; sx += 1) {
          const px = x + i * CHAR_W * scale + cx * scale + sx;
          const py = y + cy * scale + sy;
          if ((px + py) % 3 === 0) setDot(bits, width, px, py, true);
        }
      }
    });
  }
}

function drawText(bits: Uint8Array, width: number, text: string, x: number, y: number, scale: number, black: boolean) {
  let cursor = x;
  for (const character of text) {
    glyphColumns(character).forEach((column, cx) => {
      for (let cy = 0; cy < 7; cy += 1) {
        if (((column >> cy) & 1) === 0) continue;
        for (let sy = 0; sy < scale; sy += 1) for (let sx = 0; sx < scale; sx += 1) {
          setDot(bits, width, cursor + cx * scale + sx, y + cy * scale + sy, black);
        }
      }
    });
    cursor += CHAR_W * scale;
  }
}

function blit(bits: Uint8Array, width: number, source: Uint8Array, sourceWidth: number, x: number, y: number) {
  const stride = sourceWidth / 8;
  const height = source.length / stride;
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < sourceWidth; column += 1) {
      if ((source[row * stride + (column >> 3)] & (0x80 >> (column & 7))) === 0) continue;
      setDot(bits, width, x + column, y + row, true);
    }
  }
}

function hline(bits: Uint8Array, width: number, y: number) {
  for (let x = 8; x < width - 8; x += 2) setDot(bits, width, x, y, true);
}

function fillRect(bits: Uint8Array, width: number, x: number, y: number, w: number, h: number, black: boolean) {
  for (let yy = 0; yy < h; yy += 1) for (let xx = 0; xx < w; xx += 1) setDot(bits, width, x + xx, y + yy, black);
}

function setDot(bits: Uint8Array, width: number, x: number, y: number, black: boolean) {
  if (x < 0 || y < 0 || x >= width) return;
  const bytesPerRow = width / 8;
  const index = y * bytesPerRow + (x >> 3);
  if (index < 0 || index >= bits.length) return;
  const mask = 0x80 >> (x & 7);
  bits[index] = black ? bits[index] | mask : bits[index] & ~mask;
}

function wrap(text: string, maxChars: number) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [''];
  const lines: string[] = [];
  let current = '';
  for (const word of clean.split(' ')) {
    const pieces = word.length > maxChars ? word.match(new RegExp(`.{1,${maxChars}}`, 'g')) ?? [word] : [word];
    for (const piece of pieces) {
      if (!current) current = piece;
      else if (current.length + 1 + piece.length <= maxChars) current += ` ${piece}`;
      else { lines.push(current); current = piece; }
    }
  }
  if (current) lines.push(current);
  return lines;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] ?? character));
}

export function existingJobAction(status?: string) {
  if (!status) return 'print';
  if (status === 'FAILED') return 'keep';
  return 'keep';
}
