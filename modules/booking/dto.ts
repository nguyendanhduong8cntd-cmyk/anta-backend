import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsISO8601, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';
export class SlotDto {
  @ApiProperty() @IsUUID('4') yardId!: string;
  @ApiProperty({ example: '2026-10-01T09:00:00+07:00' }) @IsISO8601({ strict: true }) @Matches(/(Z|[+-]\d{2}:\d{2})$/) startsAt!: string;
  @ApiProperty({ example: '2026-10-01T10:00:00+07:00' }) @IsISO8601({ strict: true }) @Matches(/(Z|[+-]\d{2}:\d{2})$/) endsAt!: string;
}
export class BookingDto {
  @ApiProperty() @IsUUID('4') holdId!: string;
}
export class RecurringBookingDto extends SlotDto {
  @ApiProperty({ minimum: 2, maximum: 12 }) @IsInt() @Min(2) @Max(12) weeks!: number;
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
export class ParticipantDto { @ApiProperty() @IsUUID('4') userId!: string; }
export class BookingServiceDto {
  @ApiProperty() @IsUUID('4') serviceId!: string;
  @ApiProperty() @IsInt() @Min(1) @Max(20) quantity!: number;
}
export class ReviewDto {
  @ApiProperty() @IsInt() @Min(1) @Max(5) rating!: number;
  @ApiProperty() @IsString() @Length(0, 2000) comment!: string;
}
