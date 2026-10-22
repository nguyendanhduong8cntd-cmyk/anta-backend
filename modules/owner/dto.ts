import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';

export class OwnerScheduleQuery {
  @ApiProperty() @IsUUID('4') branchId!: string;
  @ApiProperty({ example: '2026-10-15' }) @Matches(/^\d{4}-\d{2}-\d{2}$/) date!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID('4') sportId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID('4') courtId?: string;
}

export class OwnerBookingQuery {
  @ApiProperty() @IsUUID('4') branchId!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 100) q?: string;
  @ApiPropertyOptional({ example: '2026-10-09' }) @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) fromDate?: string;
  @ApiPropertyOptional({ example: '2026-10-22' }) @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) toDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID('4') courtId?: string;
  @ApiPropertyOptional({ enum: ['PENDING_PAYMENT', 'PENDING_OWNER_CONFIRMATION', 'CONFIRMED', 'CANCELLED', 'EXPIRED'] })
  @IsOptional() @IsIn(['PENDING_PAYMENT', 'PENDING_OWNER_CONFIRMATION', 'CONFIRMED', 'CANCELLED', 'EXPIRED']) status?: string;
  @ApiPropertyOptional({ enum: ['APP', 'COUNTER'] }) @IsOptional() @IsIn(['APP', 'COUNTER']) source?: string;
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10000) page?: number;
  @ApiPropertyOptional({ default: 20 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}

export class OwnerStatsQuery {
  @ApiProperty() @IsUUID('4') branchId!: string;
}

export class RejectBookingDto {
  @ApiProperty({ minLength: 1, maxLength: 500 }) @IsString() @Length(1, 500) reason!: string;
}

export class BlockDto {
  @ApiProperty({ example: '2026-10-15T10:00:00+07:00' }) @IsISO8601({ strict: true }) @Matches(/(Z|[+-]\d{2}:\d{2})$/) startsAt!: string;
  @ApiProperty({ example: '2026-10-15T12:00:00+07:00' }) @IsISO8601({ strict: true }) @Matches(/(Z|[+-]\d{2}:\d{2})$/) endsAt!: string;
  @ApiProperty({ minLength: 1, maxLength: 500 }) @IsString() @Length(1, 500) reason!: string;
}

export class OwnerBlockQuery {
  @ApiPropertyOptional({ example: '2026-10-15' }) @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) date?: string;
}
