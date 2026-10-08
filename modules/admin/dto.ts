import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
export class RoleDto {
  @ApiProperty() @IsUUID('4') userId!: string;
  @ApiProperty({ enum: ['admin', 'support', 'branch_owner', 'branch_staff'] })
  @IsIn(['admin', 'support', 'branch_owner', 'branch_staff']) role!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID('4') branchId?: string;
}
export class AdminListQuery {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 100) q?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 40) status?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10000) page?: number;
}
export class ResolveRefundDto {
  @ApiProperty({ enum: ['SUCCEEDED', 'FAILED'] }) @IsIn(['SUCCEEDED', 'FAILED']) outcome!: 'SUCCEEDED' | 'FAILED';
  @ApiPropertyOptional({ description: 'Bank or provider reference of the payout' }) @IsOptional() @IsString() @Length(1, 120) providerRef?: string;
}
