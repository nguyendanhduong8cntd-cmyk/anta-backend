import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';
export class IdentifierDto {
  @ApiProperty({ example: 'demo@example.com' }) @IsString() @Length(5, 254) identifier!: string;
}
export class OtpSendDto extends IdentifierDto {
  @ApiProperty({ enum: ['register', 'reset-password'] }) @IsIn(['register', 'reset-password']) purpose!: 'register' | 'reset-password';
}
export class OtpVerifyDto {
  @ApiProperty() @IsUUID('4') challengeId!: string;
  @ApiProperty({ example: '123456' }) @Matches(/^\d{6}$/) code!: string;
}
export class RegisterDto extends IdentifierDto {
  @ApiProperty({ minLength: 10, maxLength: 128 }) @IsString() @Length(10, 128) password!: string;
  @ApiProperty() @IsString() @Length(1, 100) displayName!: string;
  @ApiProperty() @IsString() @Length(32, 128) verificationToken!: string;
  @ApiProperty() @IsString() @Length(1, 128) deviceId!: string;
}
export class LoginDto extends IdentifierDto {
  @ApiProperty() @IsString() @Length(1, 128) password!: string;
  @ApiProperty() @IsString() @Length(1, 128) deviceId!: string;
}
export class RefreshDto {
  @ApiProperty() @IsString() @Length(32, 128) refreshToken!: string;
}
export class ResetDto extends IdentifierDto {
  @ApiProperty() @IsString() @Length(32, 128) verificationToken!: string;
  @ApiProperty() @IsString() @Length(10, 128) password!: string;
}
export class ProfileDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 100) displayName?: string;
}
export class DeviceDto {
  @ApiProperty() @IsString() @Length(1, 128) deviceId!: string;
  @ApiProperty() @IsString() @Length(20, 4096) fcmToken!: string;
}
export class SocialDto {
  @ApiProperty({ description: 'Google ID token for one of this backend\'s OAuth clients' }) @IsString() @Length(100, 10000) idToken!: string;
  @ApiProperty() @IsString() @Length(1, 128) deviceId!: string;
}
export class ReauthDto {
  @ApiProperty({ description: 'The account password, typed again' }) @IsString() @Length(1, 128) password!: string;
}
export class LinkAccountDto extends ReauthDto {
  @ApiProperty() @IsString() @Length(100, 10000) idToken!: string;
}
export class DeleteAccountDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 128) password?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(100, 10000) idToken?: string;
}
