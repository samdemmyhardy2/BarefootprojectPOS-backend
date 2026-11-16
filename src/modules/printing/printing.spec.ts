import { classifyDevice } from './classify';
import { PNG } from 'pngjs';
import { pngToEscPos, rasterToEscPos } from './escpos';
import { composeSlip } from './slip';
import { expandPrivateCidr, isPrivateIpv4, localSubnets, prefixFromNetmask } from './network';
import { existingJobAction, renderReceipt } from './receipt';
import { renderStoreTitle } from './store-title';
import { snmpGetPacket } from './snmp';

describe('LAN ranges', () => {
  it('recognises private addresses and netmasks', () => {
    expect(isPrivateIpv4('192.168.1.15')).toBe(true);
    expect(isPrivateIpv4('10.4.0.8')).toBe(true);
    expect(isPrivateIpv4('172.16.0.4')).toBe(true);
    expect(isPrivateIpv4('8.8.8.8')).toBe(false);
    expect(prefixFromNetmask('255.255.255.0')).toBe(24);
  });

  it('expands only a bounded private subnet', () => {
    const range = expandPrivateCidr('192.168.1.20/24');
    expect(range.cidr).toBe('192.168.1.0/24');
    expect(range.hosts).toHaveLength(254);
    expect(range.hosts[0]).toBe('192.168.1.1');
    expect(() => expandPrivateCidr('8.8.8.0/24')).toThrow(/private/i);
    expect(() => expandPrivateCidr('10.0.0.0/16')).toThrow(/\/22/);
  });

  it('reads the server interfaces without assuming 192.168.1.x', () => {
    for (const subnet of localSubnets()) expect(isPrivateIpv4(subnet.address)).toBe(true);
  });
});

describe('device classification', () => {
  it('recognises an Epson receipt printer from name, vendor, and port evidence', () => {
    const device = classifyDevice({
      ip: '192.168.1.15',
      macAddress: '00:00:48:11:22:33',
      hostname: 'TM-m30III',
      vendor: 'Epson',
      openPorts: [9100],
      snmpText: 'EPSON TM-m30III',
    });
    expect(device).toMatchObject({
      deviceType: 'printer',
      confidence: 'high',
      manufacturer: 'Epson',
      model: 'TM-m30III',
      protocols: ['RAW', 'SNMP'],
    });
    expect(device.evidence.join(' ')).toMatch(/9100/);
  });

  it('does not invent a model for a port-9100 candidate', () => {
    const device = classifyDevice({ ip: '10.0.0.40', openPorts: [9100] });
    expect(device.deviceType).toBe('printer');
    expect(device.model).toBe('');
    expect(device.confidence).toBe('medium');
  });

  it('classifies a gateway separately from printers', () => {
    expect(classifyDevice({ ip: '192.168.1.1', vendor: 'Cisco' }).deviceType).toBe('router');
  });
});

describe('receipt raster', () => {
  const rendered = renderReceipt({
    restaurantName: 'Table & Thyme',
    customerName: 'Avery',
    vip: true,
    printedAt: '1 Nov 2026, 11:00',
    orderNumber: '18',
    location: 'Table 4',
    administrator: 'Mina',
    lines: [{ name: 'Grilled chicken with a very long kitchen name', quantity: 2, detail: 'No onion', amount: '24 THB' }],
    subtotal: '24 THB',
    total: '24 THB',
    paymentMethod: 'Cash',
    paymentStatus: 'Paid',
    servedBy: 'Noah',
    collectedBy: 'Noah',
    processedBy: 'Mina',
    footer: 'Thank you for dining with us.',
  });

  it('builds a sharp 80mm PNG and an ESC/POS raster from the same slip', () => {
    expect(rendered.width).toBe(576);
    expect(rendered.height).toBeGreaterThan(80);
    expect(rendered.png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(rendered.html).toContain('Table &amp; Thyme');
    expect(rendered.html).toContain('VIP');
    const payload = rendered.escpos;
    expect(payload.subarray(0, 2)).toEqual(Buffer.from([0x1b, 0x40]));
    expect(payload.includes(Buffer.from([0x1d, 0x76, 0x30, 0x00]))).toBe(true);
    const bytesPerRow = 576 / 8;
    expect(payload.readUInt8(6)).toBe(bytesPerRow & 0xff);
    expect(payload.length).toBeGreaterThan(bytesPerRow * rendered.height);
  });

  it('does not print again when a job already exists', () => {
    expect(existingJobAction(undefined)).toBe('print');
    expect(existingJobAction('COMPLETED')).toBe('keep');
    expect(existingJobAction('FAILED')).toBe('keep');
  });
});

describe('text receipt', () => {
  it('prints words as text and keeps only the logo as an image', () => {
    const logo = new PNG({ width: 8, height: 8 });
    for (let i = 0; i < logo.data.length; i += 4) {
      logo.data[i] = 20; logo.data[i + 1] = 20; logo.data[i + 2] = 20; logo.data[i + 3] = 255;
    }
    const slip = composeSlip({
      title: 'Room charge authorization',
      restaurantName: 'Suzy',
      location: 'Room 1',
      printedAt: '11/1/2026',
      lines: [{ left: 'Room usage fee', right: '300 THB' }, { left: '  1× Stay', right: '300 THB' }],
      total: '300 THB',
      rows: [{ left: 'Payment', right: 'Room folio' }],
      footer: 'Thank you for choosing to stay with us.',
      logoImage: `data:image/png;base64,${PNG.sync.write(logo).toString('base64')}`,
    }, 80);
    const textAt = slip.escpos.indexOf(Buffer.from('Room usage fee'));
    const imageAt = slip.escpos.indexOf(Buffer.from([0x1d, 0x76, 0x30, 0x00]));
    expect(textAt).toBeGreaterThan(-1);
    expect(imageAt).toBeGreaterThan(-1);
    expect(imageAt).toBeLessThan(textAt);
    expect(slip.escpos.includes(Buffer.from('ROOM CHARGE AUTHORIZATION'))).toBe(true);
    expect(slip.escpos.includes(Buffer.from('Suzy'))).toBe(false);
    expect(slip.html).toContain('Suzy');
    expect(slip.html).toContain('300 THB');
    expect(slip.html).not.toContain('<script');
  });
});

describe('store title', () => {
  function rowInk(bits: Uint8Array, width: number, y: number) {
    let runs = 0;
    let on = false;
    for (let x = 0; x < width; x += 1) {
      const black = (bits[y * (width / 8) + (x >> 3)] & (0x80 >> (x & 7))) !== 0;
      if (black !== on) {
        runs += 1;
        on = black;
      }
    }
    return runs;
  }

  it('prints Barefoot Project as a centered proportional raster and leaves the other lines as text', () => {
    const narrow = renderStoreTitle('I', 520, 52);
    const wide = renderStoreTitle('M', 520, 52);
    expect(narrow && wide && narrow.width).toBeLessThan(wide?.width ?? 0);
    const slip = composeSlip({
      title: 'Restaurant receipt',
      restaurantName: 'Barefoot Project',
      location: 'Koh Phayam',
      printedAt: '2 Nov 2026',
      lines: [{ left: 'Fine text line', right: '12 THB' }],
      total: '12 THB',
      rows: [{ left: 'Payment', right: 'Cash' }],
      footer: 'Thank you',
    }, 80, 203);
    const title = renderStoreTitle('Barefoot Project', 544, 52);
    expect(title).not.toBeNull();
    expect(title!.width % 8).toBe(0);
    expect(title!.width).toBeLessThan(544);
    expect(title!.height).toBeGreaterThan(36);
    expect(title!.height).toBeLessThan(64);
    const middle = rowInk(title!.bits, title!.width, Math.floor(title!.height * 0.45));
    expect(middle).toBeGreaterThanOrEqual(4);
    expect(slip.escpos.includes(title!.escpos)).toBe(true);
    expect(slip.escpos.includes(Buffer.from('Barefoot Project'))).toBe(false);
    expect(slip.escpos.includes(Buffer.from('Fine text line'))).toBe(true);
    expect(slip.escpos.includes(Buffer.from('12 THB'))).toBe(true);
    expect(slip.escpos.includes(Buffer.from([0x1b, 0x61, 0x01]))).toBe(true);
    expect(slip.html).toContain('Barefoot Project');
  });
});

describe('on-screen receipt image', () => {
  it('prints one PNG as a single ESC/POS slip', () => {
    const png = new PNG({ width: 40, height: 20 });
    for (let i = 0; i < png.data.length; i += 4) {
      png.data[i] = 30; png.data[i + 1] = 20; png.data[i + 2] = 20; png.data[i + 3] = 255;
    }
    const printed = pngToEscPos(PNG.sync.write(png), 576);
    expect(printed.width).toBe(576);
    expect(printed.height).toBeGreaterThan(0);
    expect(printed.escpos.subarray(0, 2)).toEqual(Buffer.from([0x1b, 0x40]));
    expect(printed.escpos.includes(Buffer.from([0x1d, 0x28, 0x4b, 0x02, 0x00, 0x31, 8]))).toBe(true);
  });

  it('prints gray text solid and leaves a pale background blank', () => {
    const png = new PNG({ width: 16, height: 8 });
    for (let i = 0; i < png.data.length; i += 4) {
      png.data[i] = 252; png.data[i + 1] = 231; png.data[i + 2] = 243; png.data[i + 3] = 255;
    }
    const text = (4 * 16 + 4) * 4;
    png.data[text] = 100; png.data[text + 1] = 116; png.data[text + 2] = 139; png.data[text + 3] = 255;
    const printed = pngToEscPos(PNG.sync.write(png), 16);
    const header = printed.escpos.indexOf(Buffer.from([0x1d, 0x76, 0x30, 0x00]));
    const raster = printed.escpos.subarray(header + 8, header + 8 + (16 / 8) * printed.height);
    const blackDots = [...raster].reduce((sum, byte) => sum + byte.toString(2).replace(/0/g, '').length, 0);
    expect(blackDots).toBeGreaterThan(0);
    expect(blackDots).toBeLessThan(16 * printed.height);
  });
});

describe('SNMP', () => {
  it('builds a bounded printer MIB request', () => {
    const packet = snmpGetPacket();
    expect(packet[0]).toBe(0x30);
    expect(packet.length).toBeLessThan(400);
  });
});
