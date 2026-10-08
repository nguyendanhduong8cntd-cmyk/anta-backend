import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
export const BRANCH_SORTS = ['distance', 'rating', 'price'] as const;
export const MAX_RADIUS_METERS = 20100000;
export class BranchQuery {
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsNumber() @Min(-90) @Max(90) lat?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsNumber() @Min(-180) @Max(180) lng?: number;
  // Up to half the Earth's circumference: "nearest first" must list something wherever the user is, even abroad.
  @ApiPropertyOptional({ default: 10000 }) @IsOptional() @Type(() => Number) @IsInt() @Min(100) @Max(MAX_RADIUS_METERS) radius?: number;
  @ApiPropertyOptional() @IsOptional() @IsUUID('4') sportId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 100) q?: string;
  @ApiPropertyOptional({ enum: BRANCH_SORTS, default: 'distance' }) @IsOptional() @IsIn(BRANCH_SORTS) sort?: typeof BRANCH_SORTS[number];
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10000) page?: number;
  @ApiPropertyOptional({ default: 20 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}
