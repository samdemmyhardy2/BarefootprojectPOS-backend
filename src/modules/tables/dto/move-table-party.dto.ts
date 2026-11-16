import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class MoveTablePartyDto {
  @ApiProperty({ format: 'uuid', description: 'Table the seated party is moving to.' })
  @IsUUID()
  tableId!: string;
}
