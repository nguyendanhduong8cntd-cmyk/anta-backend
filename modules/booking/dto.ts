import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsISO8601, IsInt, IsOptional, IsUUID, Matches, Max, Min } from 'class-validator';
export class SlotDto {
  @ApiProperty() @IsUUID('4') yardId!: string;
  @ApiProperty({ example: '2026-10-01T09:00:00+07:00' }) @IsISO8601({ strict: true }) @Matches(/(Z|[+-]\d{2}:\d{2})$/) startsAt!: string;
  @ApiProperty({ example: '2026-10-01T10:00:00+07:00' }) @IsISO8601({ strict: true }) @Matches(/(Z|[+-]\d{2}:\d{2})$/) endsAt!: string;
}
export class BookingDto {
  @ApiProperty() @IsUUID('4') holdId!: string;
}
export class AvailabilityQuery {
  @ApiProperty() @IsISO8601({ strict: true }) @Matches(/(Z|[+-]\d{2}:\d{2})$/) from!: string;
  @ApiProperty() @IsISO8601({ strict: true }) @Matches(/(Z|[+-]\d{2}:\d{2})$/) to!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID('4') sportId?: string;
}
export class BookingQuery {
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10000) page?: number;
  @ApiPropertyOptional({ default: 20 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}
