import { Body, Controller, Delete, Get, Headers, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { AuthRequest, CurrentUser, Public } from '../../packages/auth/guard';
import { Principal } from '../../packages/auth/tokens';
import { DeviceDto, LoginDto, OtpSendDto, OtpVerifyDto, ProfileDto, RefreshDto, RegisterDto, ResetDto } from './dto';
import { IdentityService } from './service';
@ApiTags('identity')
@Controller()
export class IdentityController {
  constructor(private readonly identity: IdentityService) {}
  @Public() @Post('public/auth/otp/send') send(@Body() dto: OtpSendDto, @Req() req: AuthRequest) { return this.identity.sendOtp(dto, req.ip || 'unknown'); }
  @Public() @Post('public/auth/otp/verify') verify(@Body() dto: OtpVerifyDto) { return this.identity.verifyOtp(dto.challengeId, dto.code); }
  @Public() @Post('public/auth/register') register(@Body() dto: RegisterDto) { return this.identity.register(dto); }
  @Public() @Post('public/auth/login') login(@Body() dto: LoginDto, @Req() req: AuthRequest) { return this.identity.login(dto, req.ip || 'unknown'); }
  @Public() @Post('public/auth/refresh') refresh(@Body() dto: RefreshDto) { return this.identity.refresh(dto.refreshToken); }
  @Public() @Post('public/auth/reset-password') reset(@Body() dto: ResetDto) { return this.identity.resetPassword(dto); }
  @Public() @Post('public/auth/social') social() { return this.identity.socialUnavailable(); }
  @Public() @Get('dev/otp/:challengeId') @ApiHeader({ name: 'X-Dev-Key', required: true })
  developmentOtp(@Param('challengeId', new ParseUUIDPipe({ version: '4' })) id: string, @Headers('x-dev-key') key?: string) { return this.identity.developmentCode(id, key); }
  @ApiBearerAuth() @Post('auth/logout') logout(@CurrentUser() user: Principal) { return this.identity.logout(user); }
  @ApiBearerAuth() @Get('users/me') me(@CurrentUser() user: Principal) { return this.identity.profile(user.userId); }
  @ApiBearerAuth() @Patch('users/me') update(@CurrentUser() user: Principal, @Body() dto: ProfileDto) { return this.identity.updateProfile(user.userId, dto.displayName); }
  @ApiBearerAuth() @Post('devices/fcm-token') device(@CurrentUser() user: Principal, @Body() dto: DeviceDto) { return this.identity.device(user.userId, dto.deviceId, dto.fcmToken); }
  @ApiBearerAuth() @Delete('users/me/devices/:deviceId') removeDevice(@CurrentUser() user: Principal, @Param('deviceId') id: string) { return this.identity.removeDevice(user.userId, id); }
}
