import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
export class PresignDto {
  @ApiProperty({ enum: ['image/jpeg', 'image/png', 'image/webp'] })
  @IsIn(['image/jpeg', 'image/png', 'image/webp']) mimeType!: string;
  @ApiProperty({ minimum: 1, maximum: 10485760 }) @IsInt() @Min(1) @Max(10485760) size!: number;
}
export class CourtPresignDto extends PresignDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID('4') yardId?: string;
}
