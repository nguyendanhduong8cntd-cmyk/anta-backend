import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID, Matches } from 'class-validator';
export class BranchFilterDto { @ApiPropertyOptional() @IsOptional() @IsUUID('4') branchId?: string; }
export class CenterFilterDto { @ApiPropertyOptional() @IsOptional() @IsUUID('4') centerId?: string; }
export class CourseFilterDto { @ApiPropertyOptional() @IsOptional() @IsUUID('4') courseId?: string; }
export class SessionTimeDto {
  @ApiProperty() @Matches(/(Z|[+-]\d{2}:\d{2})$/) startsAt!: string;
  @ApiProperty() @Matches(/(Z|[+-]\d{2}:\d{2})$/) endsAt!: string;
}
