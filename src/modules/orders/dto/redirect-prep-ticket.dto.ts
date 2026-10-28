import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { PrepStation } from 'prisma/generated/prisma/enums';

export class RedirectPrepTicketDto {
  @ApiProperty({ enum: PrepStation })
  @IsEnum(PrepStation)
  station: PrepStation;
}
