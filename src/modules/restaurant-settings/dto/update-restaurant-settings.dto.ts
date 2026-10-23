import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateRestaurantSettingsDto {
  @ApiProperty({ example: 'Table & Thyme', minLength: 1, maxLength: 80 })
  @IsString() @MinLength(1) @MaxLength(80)
  name!: string;

  @ApiPropertyOptional({ example: 'https://restaurant.example/uploads/images/logo.png', nullable: true })
  @IsOptional() @IsString() @MaxLength(500)
  logoUrl?: string | null;
}
