import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';

export class CloudbedsCalendarQueryDto {
  @ApiProperty({ example: '2026-10-22' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from!: string;

  @ApiProperty({ example: '2026-11-04' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to!: string;
}
