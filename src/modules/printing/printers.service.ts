import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from 'prisma/generated/prisma/client';
import { PrismaService } from '../../utils/prisma/prisma.service';
import { isPrivateIpv4 } from './network';
import { SavePrinterDto, UpdatePrinterDto } from './dto/printing.dto';

@Injectable()
export class PrintersService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.printer.findMany({ orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] });
  }

  async get(id: string) {
    const printer = await this.prisma.printer.findUnique({ where: { id } });
    if (!printer) throw new NotFoundException('Printer not found');
    return printer;
  }

  async create(dto: SavePrinterDto) {
    this.assertLanPrinter(dto.ipAddress, dto.port ?? 9100);
    const printers = await this.prisma.printer.count();
    const makeDefault = dto.isDefault ?? printers === 0;
    return this.prisma.$transaction(async (tx) => {
      if (makeDefault) await tx.printer.updateMany({ data: { isDefault: false } });
      return tx.printer.create({
        data: {
          name: dto.name.trim(),
          manufacturer: dto.manufacturer?.trim() ?? "",
          model: dto.model?.trim() ?? "",
          ipAddress: dto.ipAddress.trim(),
          macAddress: dto.macAddress?.trim().toUpperCase() ?? "",
          port: dto.port ?? 9100,
          connectionType: dto.connectionType ?? "RAW",
          paperWidthMm: dto.paperWidthMm ?? 80,
          resolutionDpi: dto.resolutionDpi ?? 203,
          purpose: dto.purpose ?? "RECEIPT",
          enabled: dto.enabled ?? true,
          isDefault: makeDefault,
        },
      });
    });
  }

  async update(id: string, dto: UpdatePrinterDto) {
    await this.get(id);
    if (dto.ipAddress) this.assertLanPrinter(dto.ipAddress, dto.port ?? 9100);
    return this.prisma.$transaction(async (tx) => {
      if (dto.isDefault) await tx.printer.updateMany({ data: { isDefault: false } });
      return tx.printer.update({ where: { id }, data: this.data(dto, dto.isDefault) });
    });
  }

  async remove(id: string) {
    await this.get(id);
    await this.prisma.printer.delete({ where: { id } });
    return { deleted: true };
  }

  async makeDefault(id: string) {
    await this.get(id);
    return this.prisma.$transaction(async (tx) => {
      await tx.printer.updateMany({ data: { isDefault: false } });
      return tx.printer.update({ where: { id }, data: { isDefault: true, enabled: true } });
    });
  }

  private data(dto: Partial<SavePrinterDto>, isDefault?: boolean): Prisma.PrinterUpdateInput {
    return {
      ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
      ...(dto.manufacturer !== undefined ? { manufacturer: dto.manufacturer.trim() } : {}),
      ...(dto.model !== undefined ? { model: dto.model.trim() } : {}),
      ...(dto.ipAddress !== undefined ? { ipAddress: dto.ipAddress.trim() } : {}),
      ...(dto.macAddress !== undefined ? { macAddress: dto.macAddress.trim().toUpperCase() } : {}),
      ...(dto.port !== undefined ? { port: dto.port } : {}),
      ...(dto.connectionType !== undefined ? { connectionType: dto.connectionType } : {}),
      ...(dto.paperWidthMm !== undefined ? { paperWidthMm: dto.paperWidthMm } : {}),
      ...(dto.resolutionDpi !== undefined ? { resolutionDpi: dto.resolutionDpi } : {}),
      ...(dto.purpose !== undefined ? { purpose: dto.purpose } : {}),
      ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
      ...(isDefault !== undefined ? { isDefault } : {}),
    };
  }

  private assertLanPrinter(ipAddress: string, port: number) {
    if (!isPrivateIpv4(ipAddress)) throw new BadRequestException('Printer address must be a private LAN address. This server will not connect to a public IP.');
    if (port === 9100 || port === 631 || port === 515) return;
    throw new BadRequestException('Use the printer RAW port 9100, or IPP 631 / LPR 515 when that is how the printer is configured.');
  }
}
