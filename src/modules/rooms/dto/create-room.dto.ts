import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreateRoomDto {
  @ApiProperty({ example: '16' }) @IsString() @MinLength(1) @MaxLength(80) roomNumber!: string;
}
