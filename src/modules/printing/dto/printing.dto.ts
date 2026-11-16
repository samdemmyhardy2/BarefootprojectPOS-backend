import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested } from 'class-validator';

export class ScanNetworkDto {
  @ApiPropertyOptional({ example: '192.168.1.0/24' })
  @IsOptional() @IsString() @MaxLength(32) subnet?: string;

  @ApiPropertyOptional({ enum: ['arp', 'mdns', 'snmp', 'tcp'], isArray: true })
  @IsOptional() @IsArray() @ArrayMaxSize(4) @IsIn(['arp', 'mdns', 'snmp', 'tcp'], { each: true }) methods?: Array<'arp' | 'mdns' | 'snmp' | 'tcp'>;

  @ApiPropertyOptional({ default: 400 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(200) @Max(5000) timeoutMs?: number;
}

export class SavePrinterDto {
  @ApiProperty() @IsString() @MaxLength(80) name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) manufacturer?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) model?: string;
  @ApiProperty({ example: '192.168.1.15' }) @IsString() @MaxLength(45) ipAddress!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(32) macAddress?: string;
  @ApiPropertyOptional({ default: 9100 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(65535) port?: number;
  @ApiPropertyOptional({ default: 'RAW' }) @IsOptional() @IsIn(['RAW']) connectionType?: string;
  @ApiPropertyOptional({ enum: [58, 80], default: 80 }) @IsOptional() @Type(() => Number) @IsIn([58, 80]) paperWidthMm?: number;
  @ApiPropertyOptional({ default: 203 }) @IsOptional() @Type(() => Number) @IsInt() @Min(180) @Max(300) resolutionDpi?: number;
  @ApiPropertyOptional({ enum: ['RECEIPT', 'KITCHEN'], default: 'RECEIPT' }) @IsOptional() @IsIn(['RECEIPT', 'KITCHEN']) purpose?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() enabled?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isDefault?: boolean;
}

export class UpdatePrinterDto extends PartialType(SavePrinterDto) {}

export class SlipRowDto {
  @ApiProperty() @IsString() @MaxLength(180) left!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) right?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(240) note?: string;
}

export class PrintSlipDto {
  @ApiProperty() @IsString() @MaxLength(80) title!: string;
  @ApiProperty() @IsString() @MaxLength(80) restaurantName!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) location?: string;
  @ApiProperty() @IsString() @MaxLength(80) printedAt!: string;
  @ApiProperty({ type: [SlipRowDto] }) @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => SlipRowDto) lines!: SlipRowDto[];
  @ApiPropertyOptional({ type: SlipRowDto }) @IsOptional() @ValidateNested() @Type(() => SlipRowDto) vat?: SlipRowDto;
  @ApiProperty() @IsString() @MaxLength(40) total!: string;
  @ApiProperty({ type: [SlipRowDto] }) @IsArray() @ArrayMaxSize(40) @ValidateNested({ each: true }) @Type(() => SlipRowDto) rows!: SlipRowDto[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) signatureLabel?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) signatureName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(240) signatureNote?: string;
  @ApiPropertyOptional({ description: 'PNG data URL for the guest signature only.' }) @IsOptional() @IsString() @MaxLength(2_000_000) signatureImage?: string;
  @ApiPropertyOptional({ description: 'PNG data URL for the logo only.' }) @IsOptional() @IsString() @MaxLength(2_000_000) logoImage?: string;
  @ApiProperty() @IsString() @MaxLength(160) footer!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() printerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() orderId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() clientRequestId?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() dryRun?: boolean;
}

export class PrintReceiptDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() printerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() clientRequestId?: string;
  @ApiPropertyOptional({ description: 'Render the receipt and ESC/POS bytes without opening a printer connection.' })
  @IsOptional() @IsBoolean() dryRun?: boolean;
}
