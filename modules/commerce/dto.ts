import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min, ValidateNested } from 'class-validator';
export class OrderItemDto {
  @ApiProperty() @IsUUID('4') serviceId!: string;
  @ApiProperty() @IsInt() @Min(1) @Max(20) quantity!: number;
}
export class CreateOrderDto {
  @ApiProperty() @IsUUID('4') branchId!: string;
  @ApiProperty({ type: [OrderItemDto] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => OrderItemDto) items!: OrderItemDto[];
  @ApiPropertyOptional() @IsOptional() @Matches(/^[A-Z0-9_-]{4,32}$/) voucherCode?: string;
}
export class CreateVoucherDto {
  @ApiProperty() @IsUUID('4') branchId!: string;
  @ApiProperty() @Matches(/^[A-Z0-9_-]{4,32}$/) code!: string;
  @ApiProperty() @IsInt() @Min(1) @Max(100000000) amountOff!: number;
  @ApiProperty() @IsInt() @Min(1) @Max(1000000) quota!: number;
  @ApiProperty() @Matches(/(Z|[+-]\d{2}:\d{2})$/) validFrom!: string;
  @ApiProperty() @Matches(/(Z|[+-]\d{2}:\d{2})$/) validTo!: string;
}
export class ValidateVoucherDto {
  @ApiProperty() @IsUUID('4') branchId!: string;
  @ApiProperty() @Matches(/^[A-Z0-9_-]{4,32}$/) code!: string;
  @ApiProperty() @IsInt() @Min(1) @Max(1000000000) subtotal!: number;
}
