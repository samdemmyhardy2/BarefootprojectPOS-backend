import { Injectable, UnauthorizedException, ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from 'src/utils/prisma/prisma.service';
import * as bcrypt from 'bcrypt';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { Role } from 'prisma/generated/prisma/enums';
import { uploadPath } from '../../common/upload-path';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) { }

  async register(dto: RegisterDto) {
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (existing) {
      throw new ConflictException('Email already registered');
    }

    const hashedPassword = await bcrypt.hash(dto.password, 10);

    const user = await this.prisma.user.create({
      data: {
        name: dto.name,
        email: dto.email,
        password: hashedPassword,
        role: Role.EMPLOYEE,
      },
    });

    return this.generateToken(user.id, user.email, user.role, user.name, user.jobTitle, user.avatarUrl);
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordMatches = await bcrypt.compare(dto.password, user.password);
    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { isOnline: true },
    });

    return this.generateToken(user.id, user.email, user.role, user.name, user.jobTitle, user.avatarUrl);
  }

  async profile(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id }, select: { id: true, name: true, email: true, role: true, jobTitle: true, avatarUrl: true } });
    if (!user) throw new NotFoundException('Account not found');
    return user;
  }

  async updateProfile(id: string, dto: { name?: string; avatarUrl?: string | null }) {
    const data: { name?: string; avatarUrl?: string | null } = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.avatarUrl !== undefined) data.avatarUrl = dto.avatarUrl;
    return this.prisma.user.update({ where: { id }, data, select: { id: true, name: true, email: true, role: true, jobTitle: true, avatarUrl: true } });
  }

  async changePassword(id: string, currentPassword: string, newPassword: string) {
    const user = await this.prisma.user.findUnique({ where: { id }, select: { id: true, password: true } });
    if (!user) throw new NotFoundException('Account not found');
    if (!(await bcrypt.compare(currentPassword, user.password))) throw new UnauthorizedException('Current password is incorrect');
    if (currentPassword === newPassword) throw new BadRequestException('Choose a password different from your current password');
    await this.prisma.user.update({ where: { id }, data: { password: await bcrypt.hash(newPassword, 12) } });
    return { updated: true };
  }

  private generateToken(userId: string, email: string, role: string, name: string, jobTitle: string, avatarUrl: string | null) {
    const payload = { id: userId, sub: userId, email, role, name, jobTitle, avatarUrl: avatarUrl ? uploadPath(avatarUrl) : avatarUrl };
    return {
      access_token: this.jwtService.sign(payload),
    };
  }
}
