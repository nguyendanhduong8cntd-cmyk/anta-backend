import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Min, ValidateIf } from 'class-validator';
export class IntentDto {
  @ApiProperty({ required: false }) @ValidateIf(o => !o.orderId || o.bookingId !== undefined) @IsUUID('4') bookingId?: string;
  @ApiProperty({ required: false }) @ValidateIf(o => !o.bookingId || o.orderId !== undefined) @IsUUID('4') orderId?: string;
}
export class SandboxWebhookDto {
  @ApiProperty() @IsString() @Length(8, 128) eventId!: string;
  @ApiProperty() @IsUUID('4') intentId!: string;
  @ApiProperty({ enum: ['paid'] }) @IsIn(['paid']) status!: 'paid';
  @ApiProperty() @IsInt() @Min(1) amount!: number;
  @ApiProperty({ enum: ['VND'] }) @IsIn(['VND']) currency!: 'VND';
}
