import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, IsUUID, Length, Max, Min } from 'class-validator';
export class CreatePlanDto {
  @ApiProperty() @IsUUID('4') branchId!: string;
  @ApiProperty() @IsString() @Length(2, 100) name!: string;
  @ApiProperty() @IsInt() @Min(0) @Max(100000000) price!: number;
  @ApiProperty() @IsInt() @Min(1) @Max(1000) credits!: number;
  @ApiProperty() @IsInt() @Min(1) @Max(366) durationDays!: number;
}
export class EnrollPlanDto { @ApiProperty() @IsUUID('4') planId!: string; }
