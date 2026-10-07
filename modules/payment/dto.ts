import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Min } from 'class-validator';
/** Exactly one target must be given; the service enforces it. */
export class IntentDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID('4') bookingId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID('4') orderId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID('4') contractId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID('4') enrollmentId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID('4') ticketId?: string;
}
export class SandboxWebhookDto {
  @ApiProperty() @IsString() @Length(8, 128) eventId!: string;
  @ApiProperty() @IsUUID('4') intentId!: string;
  @ApiProperty({ enum: ['paid'] }) @IsIn(['paid']) status!: 'paid';
  @ApiProperty() @IsInt() @Min(1) amount!: number;
  @ApiProperty({ enum: ['VND'] }) @IsIn(['VND']) currency!: 'VND';
}
