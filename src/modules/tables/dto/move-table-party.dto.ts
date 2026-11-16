import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class MoveTablePartyDto {
  @ApiProperty({ format: 'uuid', description: 'Table the seated party is moving to.' })
  @IsUUID()
  tableId!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Repeating this id returns the first move instead of moving the party again.' })
  @IsOptional() @IsUUID()
  clientRequestId?: string;
}
