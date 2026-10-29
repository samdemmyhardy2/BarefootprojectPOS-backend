import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from 'prisma/generated/prisma/client';
import { PrismaService } from './prisma.service';

const CLIENT_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  private normalize(key?: string | null) {
    const value = key?.trim();
    if (!value) return undefined;
    if (!CLIENT_REQUEST_ID.test(value)) throw new BadRequestException('clientRequestId must be a UUID');
    return value;
  }

  async read(tx: Prisma.TransactionClient, scope: string, key?: string | null) {
    const normalized = this.normalize(key);
    if (!normalized) return undefined;
    const existing = await tx.clientSubmission.findUnique({ where: { scope_key: { scope, key: normalized } } });
    return existing?.response;
  }

  async write(tx: Prisma.TransactionClient, scope: string, key: string | null | undefined, userId: string, response: unknown) {
    const normalized = this.normalize(key);
    if (!normalized) return;
    await tx.clientSubmission.create({
      data: { scope, key: normalized, userId, response: JSON.parse(JSON.stringify(response)) as Prisma.InputJsonValue },
    });
  }

  async recover(error: unknown, scope: string, key?: string | null) {
    const normalized = key?.trim();
    if (!normalized || !(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return undefined;
    const marker = JSON.stringify(error.meta?.target ?? '');
    if (!marker.includes('key')) return undefined;
    const existing = await this.prisma.clientSubmission.findUnique({ where: { scope_key: { scope, key: normalized } } });
    return existing?.response;
  }
}
