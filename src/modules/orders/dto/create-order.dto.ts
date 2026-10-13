import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { OrderPaymentMethod } from 'prisma/generated/prisma/enums';

export class CreateOrderItemDto {
  @ApiProperty({
    description: 'UUID of the menu item',
    example: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  })
  @IsUUID()
  @IsNotEmpty()
  menuItemId: string;

  @ApiProperty({
    description: 'Quantity of the item being ordered',
    example: 2,
    minimum: 1,
  })
  @IsInt()
  @Min(1)
  quantity: number;

  @ApiPropertyOptional({
    description: 'Ingredients to exclude for allergy or preference reasons',
    example: 'No onions, no mayo',
  })
  @IsString()
  @IsOptional()
  removeIngredients?: string;

  @ApiPropertyOptional({
    description: 'Extra toppings or additions requested',
    example: 'Extra cheese, truffle sauce',
  })
  @IsString()
  @IsOptional()
  addExtras?: string;

  @ApiPropertyOptional({
    description: 'Special notes or preparation requests for the kitchen',
    example: 'Serve dressing on the side',
  })
  @IsString()
  @IsOptional()
  specialNotes?: string;
}

export class CreateOrderDto {
  @ApiPropertyOptional({ description: 'Table receiving this order. Omit for room service.', example: 'b1f2c3d4-5678-90ab-cdef-1234567890ab' })
  @IsOptional() @IsUUID()
  tableId?: string;

  @ApiPropertyOptional({ description: 'Active guest stay to associate with this order or checkout folio.', format: 'uuid' })
  @IsOptional() @IsUUID()
  roomStayId?: string;

  @ApiPropertyOptional({ enum: OrderPaymentMethod, default: OrderPaymentMethod.CASH })
  @IsOptional() @IsEnum(OrderPaymentMethod)
  paymentMethod?: OrderPaymentMethod;

  @ApiProperty({
    type: [CreateOrderItemDto],
    description: 'List of menu items included in this order',
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  items: CreateOrderItemDto[];
}
