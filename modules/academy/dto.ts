import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';
const offset = /(Z|[+-]\d{2}:\d{2})$/;
export class CreateCenterDto {
  @ApiProperty() @IsUUID('4') branchId!: string;
  @ApiProperty() @IsString() @Length(2, 100) name!: string;
  @ApiProperty() @IsString() @Length(0, 2000) description!: string;
}
export class CreateCourseDto {
  @ApiProperty() @IsUUID('4') centerId!: string;
  @ApiProperty() @IsUUID('4') sportId!: string;
  @ApiProperty() @IsString() @Length(2, 100) name!: string;
  @ApiProperty() @IsString() @Length(0, 2000) description!: string;
}
export class CreateClassDto {
  @ApiProperty() @IsUUID('4') courseId!: string;
  @ApiProperty() @Matches(offset) startsAt!: string;
  @ApiProperty() @Matches(offset) endsAt!: string;
  @ApiProperty() @IsInt() @Min(1) @Max(1000) capacity!: number;
  @ApiProperty() @IsInt() @Min(0) @Max(100000000) price!: number;
}
export class AttendDto {
  @ApiProperty() @IsUUID('4') enrollmentId!: string;
  @ApiProperty() @IsBoolean() present!: boolean;
}
