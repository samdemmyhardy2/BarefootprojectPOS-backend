import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayUnique, IsArray, IsOptional, IsUUID } from 'class-validator';

export class AssignBillPayerDto {
  @ApiProperty({ type: [String], description: 'Open orders on this table to move to one payer.' })
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  orderIds!: string[];

  @ApiPropertyOptional({ description: 'Checked-in guest stay. Omit to charge the bill to walk-ins.' })
  @IsOptional()
  @IsUUID()
  roomStayId?: string;
}
