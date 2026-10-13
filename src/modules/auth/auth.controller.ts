import { Body, Controller, Get, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiConflictResponse, ApiOperation, ApiResponse, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength, Validate, ValidatorConstraint, type ValidatorConstraintInterface } from 'class-validator';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

@ValidatorConstraint({ name: 'isAvatarImageUrl', async: false })
class AvatarImageUrlConstraint implements ValidatorConstraintInterface {
  validate(value: unknown) {
    if (value === null || value === undefined) return true;
    if (typeof value !== 'string' || value.length > 2048) return false;
    if (value.startsWith('/uploads/images/')) return /^\/uploads\/images\/[A-Za-z0-9_-]+\.(?:jpe?g|png|webp|gif)$/i.test(value);
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }
  defaultMessage() { return 'avatarUrl must be an HTTP(S) URL or a local uploaded image path'; }
}

class UpdateProfileDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @IsOptional() @IsString() @Validate(AvatarImageUrlConstraint) avatarUrl?: string | null;
}
class ChangePasswordDto {
  @IsString() currentPassword!: string;
  @IsString() @MinLength(8) newPassword!: string;
}

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  @Post('register') @ApiOperation({ summary: 'Register an employee account' }) @ApiResponse({ status: 201, description: 'Employee registered; returns a bearer token.' }) @ApiConflictResponse({ description: 'Email is already registered.' }) @ApiBadRequestResponse({ description: 'Invalid registration data.' })
  register(@Body() dto: RegisterDto) { return this.auth.register(dto); }
  @Post('login') @ApiOperation({ summary: 'Log in' }) @ApiResponse({ status: 201, description: 'Returns a bearer token.' }) @ApiUnauthorizedResponse({ description: 'Invalid email or password.' })
  login(@Body() dto: LoginDto) { return this.auth.login(dto); }
  @Get('me') @UseGuards(JwtAuthGuard) @ApiBearerAuth() @ApiOperation({ summary: 'Get current account profile' })
  me(@GetUser('id') id: string) { return this.auth.profile(id); }
  @Patch('me') @UseGuards(JwtAuthGuard) @ApiBearerAuth() @ApiOperation({ summary: 'Update own name or profile image' })
  updateProfile(@GetUser('id') id: string, @Body() dto: UpdateProfileDto) { return this.auth.updateProfile(id, dto); }
  @Post('me/change-password') @UseGuards(JwtAuthGuard) @ApiBearerAuth() @ApiOperation({ summary: 'Change own password' })
  changePassword(@GetUser('id') id: string, @Body() dto: ChangePasswordDto) { return this.auth.changePassword(id, dto.currentPassword, dto.newPassword); }
}
