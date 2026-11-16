import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsEnum, IsNumber, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { OrderPaymentMethod } from 'prisma/generated/prisma/enums';

export class SettlePartyDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional() @IsUUID()
  clientRequestId?: string;

  @ApiProperty({ type: [String], format: 'uuid' })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsUUID(undefined, { each: true })
  orderIds!: string[];

  @ApiProperty({ enum: [OrderPaymentMethod.CASH, OrderPaymentMethod.CARD, OrderPaymentMethod.PROMPTPAY, OrderPaymentMethod.ROOM_CHECKOUT] })
  @IsEnum(OrderPaymentMethod)
  paymentMethod!: OrderPaymentMethod;

  @ApiPropertyOptional({ description: 'Required for a room folio charge.' })
  @IsOptional() @IsString() @MaxLength(120)
  signedByName?: string;

  @ApiPropertyOptional({ description: 'Data URL or encoded signature image, required for a room folio charge.' })
  @IsOptional() @IsString() @MaxLength(500000)
  signatureData?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Guest stay to charge when the bill goes on a room tab.' })
  @IsOptional() @IsUUID()
  roomStayId?: string;

  @ApiPropertyOptional({ description: 'Amount the register is collecting. The whole open total is settled.' })
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0)
  amount?: number;
}
