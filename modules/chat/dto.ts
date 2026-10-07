import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min, ValidateNested } from 'class-validator';
const base64 = /^[A-Za-z0-9+/]+={0,2}$/, device = /^[A-Za-z0-9_.-]{8,64}$/;
export class ConversationDto {
  @ApiProperty() @IsString() @Length(2, 100) title!: string;
  @ApiProperty({ type: [String] }) @IsArray() @ArrayMaxSize(49) @IsUUID('4', { each: true }) memberIds!: string[];
  @ApiPropertyOptional({ description: 'End-to-end encrypted: the server stores per-device ciphertext only' }) @IsOptional() @IsBoolean() encrypted?: boolean;
}
export class EnvelopeDto {
  @ApiProperty() @IsUUID('4') recipientId!: string;
  @ApiProperty() @Matches(device) deviceId!: string;
  @ApiProperty({ enum: ['PREKEY', 'MESSAGE'] }) @IsIn(['PREKEY', 'MESSAGE']) kind!: 'PREKEY' | 'MESSAGE';
  @ApiProperty({ description: 'Base64 Signal ciphertext' }) @Matches(base64) @Length(4, 16384) ciphertext!: string;
}
export class MessageDto {
  @ApiPropertyOptional({ description: 'Plaintext; only for conversations without encryption' }) @IsOptional() @IsString() @Length(1, 4000) body?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(device) senderDeviceId?: string;
  @ApiPropertyOptional({ type: [EnvelopeDto] }) @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200)
  @ValidateNested({ each: true }) @Type(() => EnvelopeDto) envelopes?: EnvelopeDto[];
}
export class ReadDto { @ApiProperty() @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) seq!: number; }
export class PreKeyDto {
  @ApiProperty() @IsInt() @Min(0) @Max(16777215) keyId!: number;
  @ApiProperty() @Matches(base64) @Length(40, 64) publicKey!: string;
}
export class SignedPreKeyDto extends PreKeyDto {
  @ApiProperty() @Matches(base64) @Length(80, 100) signature!: string;
}
export class KeyBundleDto {
  @ApiProperty() @Matches(device) deviceId!: string;
  @ApiProperty() @IsInt() @Min(1) @Max(16380) registrationId!: number;
  @ApiProperty({ description: 'Base64 Curve25519 identity public key' }) @Matches(base64) @Length(40, 64) identityKey!: string;
  @ApiProperty({ type: SignedPreKeyDto }) @ValidateNested() @Type(() => SignedPreKeyDto) signedPreKey!: SignedPreKeyDto;
  @ApiProperty({ type: [PreKeyDto] }) @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => PreKeyDto) oneTimePreKeys!: PreKeyDto[];
}
