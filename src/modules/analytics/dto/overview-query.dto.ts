import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsString, MaxLength } from 'class-validator';

export class OverviewQueryDto {
  @ApiProperty({ example: '2026-10-17', description: 'Inclusive first day of the report in the requested time zone.' })
  @IsDateString({ strict: true })
  startDate!: string;

  @ApiProperty({ example: '2026-10-17', description: 'Inclusive last day of the report in the requested time zone.' })
  @IsDateString({ strict: true })
  endDate!: string;

  @ApiProperty({ example: 'Asia/Yangon', description: 'IANA time zone used for day boundaries and chart buckets.' })
  @IsString()
  @MaxLength(80)
  timeZone!: string;
}
