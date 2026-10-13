import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { TableStatus } from 'prisma/generated/prisma/enums';

export class UpdateTableStatusDto {
  @ApiProperty({ enum: TableStatus, example: TableStatus.RESERVED })
  @IsEnum(TableStatus)
  status!: TableStatus;
}
