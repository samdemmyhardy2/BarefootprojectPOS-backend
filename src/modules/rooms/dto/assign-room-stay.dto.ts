import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class AssignRoomStayDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() roomId!: string;
}
