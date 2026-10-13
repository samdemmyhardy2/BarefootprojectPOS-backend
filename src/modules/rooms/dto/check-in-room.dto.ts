import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CheckInRoomDto {
  @ApiProperty({ example: 'Jordan Lee' }) @IsString() @IsNotEmpty() @MaxLength(120) primaryGuestName!: string;
  @ApiPropertyOptional({ type: [String], example: ['Jordan Lee', 'Taylor Lee'] }) @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) occupants?: string[];
}
