import { ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrintJobStatus } from 'prisma/generated/prisma/enums';
import { PrismaService } from '../../utils/prisma/prisma.service';
import { checkTcp, sendTcp } from './escpos';
import { isPrivateIpv4 } from './network';
import { PrintersService } from './printers.service';
import { moneyLabel, renderReceipt, type ReceiptDocument, type ReceiptLine } from './receipt';
import { dishVat, totalWithDishVat } from '../../common/vat';
import { composeSlip, type SlipInput } from './slip';

const SOCKET_NOTE = 'The printer accepted the bytes on TCP. Raw printing does not confirm that paper was cut.';

@Injectable()
export class PrintingService implements OnModuleInit {
  private readonly logger = new Logger(PrintingService.name);
  constructor(private readonly prisma: PrismaService, private readonly printers: PrintersService) {}

  async onModuleInit() {
    const host = process.env.PRINTER_HOST?.trim();
    const port = Number(process.env.PRINTER_PORT ?? 9100);
    if (!host || !isPrivateIpv4(host)) return;
    try {
      const existing = await this.prisma.printer.count();
      if (existing > 0) return;
      await this.prisma.printer.create({
        data: { name: 'Epson TM-m30III', manufacturer: 'Epson', model: 'TM-m30III', ipAddress: host, port: Number.isInteger(port) ? port : 9100, isDefault: true, purpose: 'RECEIPT' },
      });
    } catch (error) {
      this.logger.warn(`Printer seed skipped: ${error instanceof Error ? error.message : 'database is not ready'}`);
    }
  }

  async status() {
    const [printers, lastJob] = await Promise.all([
      this.prisma.printer.findMany({ orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] }),
      this.prisma.printJob.findFirst({ orderBy: { createdAt: 'desc' } }),
    ]);
    return { printers: printers.length, defaultPrinter: printers.find((printer) => printer.isDefault) ?? null, lastJob, dryRun: process.env.PRINT_DRY_RUN === 'true' };
  }

  async preview(orderId: string) {
    const document = await this.documentFor(orderId);
    const rendered = renderReceipt(document);
    return { orderId, width: rendered.width, height: rendered.height, pngBase64: rendered.png.toString('base64'), html: rendered.html };
  }

  async print(orderId: string, userId: string, input: { printerId?: string; clientRequestId?: string; dryRun?: boolean }) {
    if (input.clientRequestId) {
      const existing = await this.prisma.printJob.findUnique({ where: { idempotencyKey: input.clientRequestId } });
      if (existing) return this.present(existing, true);
    }
    const printer = await this.savedPrinter(input.printerId);
    const dryRun = input.dryRun === true || process.env.PRINT_DRY_RUN === 'true';
    const job = await this.prisma.printJob.create({
      data: { orderId, printerId: printer.id, requestedById: userId, idempotencyKey: input.clientRequestId, dryRun, status: PrintJobStatus.PENDING },
    }).catch(async (error: { code?: string }) => {
      if (error.code === 'P2002' && input.clientRequestId) {
        const existing = await this.prisma.printJob.findUnique({ where: { idempotencyKey: input.clientRequestId } });
        if (existing) return existing;
      }
      throw error;
    });
    if (job.status !== PrintJobStatus.PENDING) return this.present(job, true);
    return this.dispatch(job.id, dryRun);
  }

  async previewSlip(input: SlipInput & { printerId?: string }) {
    const printer = input.printerId
      ? await this.savedPrinter(input.printerId)
      : await this.prisma.printer.findFirst({ where: { enabled: true, purpose: 'RECEIPT' }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] });
    return { html: composeSlip(input, printer?.paperWidthMm ?? 80, printer?.resolutionDpi ?? 203).html };
  }

  async printSlip(userId: string, input: SlipInput & { printerId?: string; orderId?: string; clientRequestId?: string; dryRun?: boolean }) {
    if (input.clientRequestId) {
      const existing = await this.prisma.printJob.findUnique({ where: { idempotencyKey: input.clientRequestId } });
      if (existing) return this.present(existing, true);
    }
    const printer = await this.savedPrinter(input.printerId);
    const dryRun = input.dryRun === true || process.env.PRINT_DRY_RUN === 'true';
    const rendered = composeSlip(input, printer.paperWidthMm, printer.resolutionDpi);
    const job = await this.prisma.printJob.create({
      data: { orderId: input.orderId ?? null, printerId: printer.id, requestedById: userId, idempotencyKey: input.clientRequestId, dryRun, status: PrintJobStatus.RENDERING, renderedAt: new Date() },
    }).catch(async (error: { code?: string }) => {
      if (error.code === 'P2002' && input.clientRequestId) {
        const existing = await this.prisma.printJob.findUnique({ where: { idempotencyKey: input.clientRequestId } });
        if (existing) return existing;
      }
      throw error;
    });
    if (job.status !== PrintJobStatus.RENDERING) return this.present(job, true);
    if (dryRun) {
      const done = await this.prisma.printJob.update({ where: { id: job.id }, data: { status: PrintJobStatus.COMPLETED, completedAt: new Date() } });
      return { ...this.present(done, false), note: 'Dry run. Nothing was sent to the printer.' };
    }
    try {
      this.assertRaw(printer);
      await this.prisma.printJob.update({ where: { id: job.id }, data: { status: PrintJobStatus.PRINTING } });
      await sendTcp(printer.ipAddress, printer.port, rendered.escpos, Number(process.env.PRINT_CONNECT_TIMEOUT_MS ?? 8000));
      const sent = await this.prisma.printJob.update({ where: { id: job.id }, data: { status: PrintJobStatus.COMPLETED, sentAt: new Date(), completedAt: new Date(), error: null } });
      return { ...this.present(sent, false), note: SOCKET_NOTE };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Printing failed';
      const failed = await this.prisma.printJob.update({ where: { id: job.id }, data: { status: PrintJobStatus.FAILED, error: message } });
      return this.present(failed, false);
    }
  }

  async retry(jobId: string) {
    const job = await this.job(jobId);
    if (!job.orderId) throw new ConflictException('Open the receipt and print it again.');
    if (job.status !== PrintJobStatus.FAILED) {
      throw new ConflictException('This receipt may already have been sent to the printer. Start a new print only if you mean to reprint it.');
    }
    await this.prisma.printJob.update({ where: { id: job.id }, data: { status: PrintJobStatus.PENDING, error: null, retryCount: { increment: 1 } } });
    return this.dispatch(job.id, job.dryRun);
  }

  async job(id: string) {
    const job = await this.prisma.printJob.findUnique({ where: { id }, include: { printer: true } });
    if (!job) throw new NotFoundException('Print job not found');
    return job;
  }

  async testConnection(id: string) {
    const printer = await this.printers.get(id);
    this.assertPrivate(printer.ipAddress);
    const result = await checkTcp(printer.ipAddress, printer.port, Number(process.env.PRINT_CONNECT_TIMEOUT_MS ?? 3000));
    const checked = await this.prisma.printer.update({
      where: { id },
      data: { lastCheckedAt: new Date(), lastCheckOk: result.reachable },
    });
    return { printer: checked, reachable: result.reachable, error: result.error ?? null, printed: false, note: 'This check only opens a TCP connection. It does not print.' };
  }

  async testPrint(id: string) {
    const printer = await this.printers.get(id);
    this.assertRaw(printer);
    const rendered = renderReceipt({
      restaurantName: 'Table & Thyme', customerName: 'Printer test', vip: false, printedAt: new Date().toLocaleString(),
      orderNumber: 'TEST', location: printer.name, administrator: 'Connection test', lines: [{ name: 'Test slip', quantity: 1, detail: '', amount: '' }],
      subtotal: '', total: 'TEST', paymentMethod: 'No charge', paymentStatus: 'Test', servedBy: '-', collectedBy: '-', processedBy: '-',
      footer: 'If you can read this, the printer received the slip.',
    }, printer.paperWidthMm, printer.resolutionDpi);
    await sendTcp(printer.ipAddress, printer.port, rendered.escpos, Number(process.env.PRINT_CONNECT_TIMEOUT_MS ?? 3000));
    return { sent: true, printed: false, note: SOCKET_NOTE };
  }

  private async dispatch(jobId: string, dryRun: boolean) {
    const job = await this.job(jobId);
    try {
      await this.prisma.printJob.update({ where: { id: job.id }, data: { status: PrintJobStatus.RENDERING } });
      if (!job.orderId) throw new ConflictException('Open the receipt and print it again.');
      const rendered = renderReceipt(await this.documentFor(job.orderId), job.printer.paperWidthMm, job.printer.resolutionDpi);
      await this.prisma.printJob.update({ where: { id: job.id }, data: { renderedAt: new Date(), status: dryRun ? PrintJobStatus.COMPLETED : PrintJobStatus.PRINTING, completedAt: dryRun ? new Date() : null } });
      if (dryRun) {
        const done = await this.job(job.id);
        return { ...this.present(done, false), pngBase64: rendered.png.toString('base64'), note: 'Dry run. Nothing was sent to the printer.' };
      }
      this.assertRaw(job.printer);
      await sendTcp(job.printer.ipAddress, job.printer.port, rendered.escpos, Number(process.env.PRINT_CONNECT_TIMEOUT_MS ?? 3000));
      const sent = await this.prisma.printJob.update({ where: { id: job.id }, data: { status: PrintJobStatus.COMPLETED, sentAt: new Date(), completedAt: new Date(), error: null } });
      return { ...this.present(sent, false), note: SOCKET_NOTE };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Printing failed';
      const failed = await this.prisma.printJob.update({ where: { id: job.id }, data: { status: PrintJobStatus.FAILED, error: message } });
      return this.present(failed, false);
    }
  }

  private async savedPrinter(printerId?: string) {
    if (printerId) {
      const printer = await this.printers.get(printerId);
      if (!printer.enabled) throw new ConflictException('That printer is turned off');
      this.assertPrivate(printer.ipAddress);
      return printer;
    }
    const printer = await this.prisma.printer.findFirst({ where: { enabled: true, isDefault: true } })
      ?? await this.prisma.printer.findFirst({ where: { enabled: true, purpose: 'RECEIPT' } });
    if (!printer) throw new ConflictException('Save a receipt printer before printing.');
    this.assertPrivate(printer.ipAddress);
    return printer;
  }

  private async documentFor(orderId: string): Promise<ReceiptDocument> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: { include: { menuItem: true } },
        waiter: { select: { name: true } },
        servedBy: { select: { name: true } },
        paidBy: { select: { name: true } },
        table: { select: { tableNumber: true } },
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status === 'CANCELLED') throw new ConflictException('Cancelled orders are not printed');
    const settings = await this.prisma.restaurantSetting.findUnique({ where: { id: 'restaurant' } });
    const tableCopy = snapshot(order.tableSnapshot);
    const lines: ReceiptLine[] = order.items.map((item) => {
      const copy = snapshot(item.itemSnapshot);
      const name = text(copy.name) || item.menuItem?.name || 'Removed dish';
      const modifiers = Array.isArray(item.modifierSelections) ? item.modifierSelections.flatMap((selection) => {
        const record = snapshot(selection);
        const options = Array.isArray(record.options) ? record.options.map((option) => text(snapshot(option).name)).filter(Boolean) : [];
        return options.length ? [`${text(record.groupName) || 'Option'}: ${options.join(', ')}`] : [];
      }) : [];
      return { name, quantity: item.quantity, detail: modifiers.join(' · '), amount: moneyLabel(Number(item.subtotal)) };
    });
    const activeItems = order.items.filter((item) => !item.removedAt);
    const dishAmounts = (activeItems.length ? activeItems : order.items).map((item) => Number(item.subtotal));
    const subtotal = dishAmounts.reduce((sum, amount) => sum + amount, 0);
    const vat = dishVat(dishAmounts, Number(order.vatPercent));
    const rate = Number(order.vatPercent) || 0;
    return {
      restaurantName: settings?.name || 'Table & Thyme',
      customerName: order.customerName?.trim() || '',
      vip: Boolean(order.customerName?.trim()),
      printedAt: new Date().toLocaleString(),
      orderNumber: String(order.number),
      location: text(tableCopy.tableNumber) || order.table?.tableNumber || 'Room service',
      administrator: order.paidBy?.name || order.waiter.name,
      lines,
      subtotal: moneyLabel(subtotal),
      ...(vat > 0 ? { vat: `${Number.isInteger(rate) ? rate : rate}%`, vatLabel: "VAT" } : {}),
      total: moneyLabel(totalWithDishVat(dishAmounts, rate)),
      paymentMethod: methodLabel(order.paymentMethod),
      paymentStatus: statusLabel(order.paymentStatus),
      servedBy: order.waiter.name,
      collectedBy: order.servedBy?.name || '—',
      processedBy: order.paidBy?.name || order.waiter.name,
      footer: 'Thank you for dining with us.',
    };
  }

  private present(job: { id: string; orderId: string | null; printerId: string; status: PrintJobStatus; error: string | null; dryRun: boolean; sentAt: Date | null; renderedAt: Date | null; completedAt: Date | null; retryCount: number }, duplicate: boolean) {
    return {
      id: job.id, orderId: job.orderId, printerId: job.printerId, status: job.status, error: job.error, dryRun: job.dryRun,
      duplicate, retryCount: job.retryCount, renderedAt: job.renderedAt, sentAt: job.sentAt, completedAt: job.completedAt,
      physicalPrintConfirmed: false,
    };
  }

  private assertPrivate(ipAddress: string) {
    if (!isPrivateIpv4(ipAddress)) throw new ConflictException('The saved printer address is not a private LAN address');
  }

  private assertRaw(printer: { port: number; connectionType: string }) {
    if (printer.connectionType !== 'RAW' || printer.port !== 9100) throw new ConflictException('Receipt printing sends ESC/POS to TCP port 9100');
  }
}

function snapshot(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function methodLabel(method: string) {
  if (method === 'CASH') return 'Cash';
  if (method === 'CARD') return 'Card';
  if (method === 'PROMPTPAY') return 'PromptPay';
  return 'Room folio';
}

function statusLabel(status: string) {
  if (status === 'PAID') return 'Paid';
  if (status === 'ROOM_FOLIO') return 'On tab';
  return 'Unpaid';
}
