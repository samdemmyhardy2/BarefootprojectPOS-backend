import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  ArrayMaxSize,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { OrderPaymentMethod, OrderType, PrepStation } from 'prisma/generated/prisma/enums';

export class ModifierSelectionDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() groupId: string;
  @ApiProperty({ type: [String], format: 'uuid' }) @IsArray() @ArrayMaxSize(40) @IsUUID(undefined, { each: true }) optionIds: string[];
}

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

  @ApiPropertyOptional({ description: 'Amount entered for a dish marked as a manual variable.', minimum: 0 })
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0)
  unitPrice?: number;

  @ApiPropertyOptional({ enum: PrepStation, description: 'Preparation station for this order line. Defaults to the menu item station.' })
  @IsOptional() @IsEnum(PrepStation)
  prepStation?: PrepStation;

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

  @ApiPropertyOptional({ type: [String], description: 'Canonical English allergen labels selected from this menu item. Localized by each kitchen employee.' })
  @IsOptional() @IsArray() @ArrayMaxSize(40) @IsString({ each: true })
  selectedAllergens?: string[];

  @ApiPropertyOptional({ type: [ModifierSelectionDto], description: 'Structured selections from the modifier groups attached to this menu item.' })
  @IsOptional() @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => ModifierSelectionDto)
  modifierSelections?: ModifierSelectionDto[];

  @ApiPropertyOptional({ description: 'Marks only this dish so the kitchen shows a glowing comment icon.' })
  @IsOptional() @IsBoolean()
  kitchenFlag?: boolean;
}

export class CreateOrderDto {
  @ApiPropertyOptional({ enum: OrderType, description: 'Pickup, restaurant table, or room service. Inferred for existing table and room orders when omitted.' })
  @IsOptional() @IsEnum(OrderType)
  type?: OrderType;

  @ApiPropertyOptional({ description: 'Customer name for a pickup order', maxLength: 120 })
  @IsOptional() @IsString() @MaxLength(120)
  customerName?: string;

  @ApiPropertyOptional({ description: 'Customer phone for a pickup order', maxLength: 40 })
  @IsOptional() @IsString() @MaxLength(40)
  customerPhone?: string;

  @ApiPropertyOptional({ description: 'Table receiving this order. Omit for room service.', example: 'b1f2c3d4-5678-90ab-cdef-1234567890ab' })
  @IsOptional() @IsUUID()
  tableId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Side of a split table, such as 5A or 5B. Orders on different sides stay separate.' })
  @IsOptional() @IsUUID()
  tableSplitId?: string;

  @ApiPropertyOptional({ description: 'Active guest stay to associate with this order or checkout folio.', format: 'uuid' })
  @IsOptional() @IsUUID()
  roomStayId?: string;

  @ApiPropertyOptional({ enum: OrderPaymentMethod, default: OrderPaymentMethod.CASH })
  @IsOptional() @IsEnum(OrderPaymentMethod)
  paymentMethod?: OrderPaymentMethod;

  @ApiPropertyOptional({ format: 'uuid', description: 'Client id for this send. Repeating it returns the original order instead of creating another.' })
  @IsOptional() @IsUUID()
  clientRequestId?: string;

  @ApiProperty({
    type: [CreateOrderItemDto],
    description: 'List of menu items included in this order',
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  items: CreateOrderItemDto[];
}

export class SetKitchenFlagDto {
  @ApiProperty({ description: 'True shows the glowing comment icon on this dish only.' })
  @IsBoolean()
  flagged: boolean;
}

export class RemoveOrderItemDto {
  @ApiProperty({ example: 'Guest changed their mind' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(240)
  reason!: string;
}

export class ClientRequestDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Repeating this id returns the first result instead of doing the action again.' })
  @IsOptional() @IsUUID()
  clientRequestId?: string;
}
