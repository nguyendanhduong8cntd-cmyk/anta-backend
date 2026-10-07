import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';
export class RoleDto {
  @ApiProperty() @IsUUID('4') userId!: string;
  @ApiProperty({ enum: ['admin', 'support', 'branch_owner', 'branch_staff', 'coach'] })
  @IsIn(['admin', 'support', 'branch_owner', 'branch_staff', 'coach']) role!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID('4') branchId?: string;
}
