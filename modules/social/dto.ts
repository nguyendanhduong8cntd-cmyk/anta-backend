import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';
export class CreateEventDto {
  @ApiProperty() @IsUUID('4') branchId!: string;
  @ApiProperty() @IsString() @Length(2, 120) title!: string;
  @ApiProperty() @IsString() @Length(0, 2000) description!: string;
  @ApiProperty() @Matches(/(Z|[+-]\d{2}:\d{2})$/) startsAt!: string;
  @ApiProperty() @Matches(/(Z|[+-]\d{2}:\d{2})$/) endsAt!: string;
  @ApiProperty() @IsInt() @Min(1) @Max(10000) capacity!: number;
  @ApiProperty() @IsInt() @Min(0) @Max(100000000) ticketPrice!: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() membershipRequired?: boolean;
}
export class BuyTicketDto { @ApiPropertyOptional() @IsOptional() @IsUUID('4') contractId?: string; }
export class QrDto { @ApiProperty() @Matches(/^[0-9a-fA-F-]{36}\.[0-9a-f]{64}$/) token!: string; }
export class CreateTeamDto { @ApiProperty() @IsString() @Length(2, 100) name!: string; }
export class CreateInvitationDto { @ApiProperty() @IsUUID('4') teamId!: string; @ApiProperty() @IsInt() @Min(1) @Max(100) maxUses!: number; }
export class AcceptInvitationDto { @ApiProperty() @IsString() @Length(32, 128) token!: string; }
export class CreateMatchDto {
  @ApiProperty() @IsUUID('4') homeTeamId!: string;
  @ApiProperty() @IsUUID('4') awayTeamId!: string;
}
export class MatchResultDto {
  @ApiProperty() @IsInt() @Min(0) @Max(1000) homeScore!: number;
  @ApiProperty() @IsInt() @Min(0) @Max(1000) awayScore!: number;
}
