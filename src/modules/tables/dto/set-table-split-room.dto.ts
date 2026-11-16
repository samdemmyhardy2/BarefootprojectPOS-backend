import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID, ValidateIf } from 'class-validator';

export class SetTableSplitRoomDto {
  @ApiPropertyOptional({ format: 'uuid', nullable: true, description: 'Guest stay remembered on this side of the table. Null clears it.' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  roomStayId?: string | null;
}
