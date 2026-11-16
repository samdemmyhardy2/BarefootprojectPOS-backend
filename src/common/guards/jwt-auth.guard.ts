import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { PrismaService } from 'src/utils/prisma/prisma.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { STREAM_TOKEN_KEY } from '../decorators/stream-token.decorator';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private jwtService: JwtService,
    private reflector: Reflector,
    private prisma: PrismaService,
  ) { }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const allowStreamToken = this.reflector.getAllAndOverride<boolean>(STREAM_TOKEN_KEY, [
      context.getHandler(),
    ]);
    const headerToken = this.extractTokenFromHeader(request);
    const queryToken = allowStreamToken && typeof request.query.streamToken === 'string'
      ? request.query.streamToken
      : undefined;
    const token = headerToken ?? queryToken;

    if (!token) {
      throw new UnauthorizedException('Access token missing');
    }

    try {
      const payload = await this.jwtService.verifyAsync(token, {
        secret: process.env.JWT_SECRET || 'super-secret-key',
      });
      if (queryToken && payload.scope !== 'orders:stream') {
        throw new UnauthorizedException('Invalid order stream token');
      }
      if (payload.scope !== 'orders:stream') await this.useCurrentAccount(payload);
      request['user'] = payload;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    return true;
  }

  /** A signed-in account that was recreated keeps the same email. Use the current record so orders are not refused. */
  private async useCurrentAccount(payload: { id?: string; sub?: string; email?: string; role?: string; name?: string; jobTitle?: string }) {
    const id = payload.id ?? payload.sub;
    if (!id) throw new UnauthorizedException('Your sign-in is no longer valid. Sign in again.');
    const current = await this.prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (current) return;
    const email = typeof payload.email === 'string' ? payload.email.trim() : '';
    const match = email
      ? await this.prisma.user.findUnique({ where: { email }, select: { id: true, role: true, name: true, jobTitle: true } })
      : null;
    if (!match) throw new UnauthorizedException('Your sign-in is no longer valid. Sign in again.');
    payload.id = match.id;
    payload.sub = match.id;
    payload.role = match.role;
    payload.name = match.name;
    payload.jobTitle = match.jobTitle;
  }

  private extractTokenFromHeader(request: Request): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
