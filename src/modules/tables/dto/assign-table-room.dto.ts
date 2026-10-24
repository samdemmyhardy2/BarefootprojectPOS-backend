import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayUnique, IsArray, IsUUID } from 'class-validator';

export class AssignTableRoomDto {
  @ApiProperty({
    type: [String],
    description: 'Active guest stays assigned to the table. Send an empty array to clear assignments.',
  })
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  roomStayIds!: string[];
}
