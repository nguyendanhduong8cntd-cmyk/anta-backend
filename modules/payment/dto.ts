import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsString, IsUUID, Length, Min } from 'class-validator';
export class IntentDto {
  @ApiProperty() @IsUUID('4') bookingId!: string;
}
export class SandboxWebhookDto {
  @ApiProperty() @IsString() @Length(8, 128) eventId!: string;
  @ApiProperty() @IsUUID('4') intentId!: string;
  @ApiProperty({ enum: ['paid'] }) @IsIn(['paid']) status!: 'paid';
  @ApiProperty() @IsInt() @Min(1) amount!: number;
  @ApiProperty({ enum: ['VND'] }) @IsIn(['VND']) currency!: 'VND';
}
