import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class CloudbedsRoomActionDto {
  @ApiProperty({ description: 'Cloudbeds reservationID' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  reservationID!: string;

  @ApiPropertyOptional({ description: 'Cloudbeds subReservationID. When set, roomID is ignored by Cloudbeds.' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  subReservationID?: string;

  @ApiPropertyOptional({ description: 'Cloudbeds roomID of the assigned room' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  roomID?: string;

  @ApiPropertyOptional({ description: 'Cloudbeds room name, used to open or close the matching folio in this system' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  roomName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  guestName?: string;

  @ApiPropertyOptional({ example: '2026-11-02' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  checkOut?: string;
}
