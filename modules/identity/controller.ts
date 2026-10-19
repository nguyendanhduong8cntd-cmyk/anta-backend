import { Body, Controller, Delete, Get, Headers, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { AuthRequest, CurrentUser, Public } from '../../packages/auth/guard';
import { Principal } from '../../packages/auth/tokens';
import { DeleteAccountDto, DeviceDto, LinkAccountDto, LoginDto, OtpSendDto, OtpVerifyDto, ProfileDto, ReauthDto, RefreshDto, RegisterDto, ResetDto, SocialDto } from './dto';
import { IdentityService } from './service';
@ApiTags('identity')
@Controller()
export class IdentityController {
  constructor(private readonly identity: IdentityService) {}
  @Public() @Post('public/auth/otp/send') @ApiHeader({ name: 'X-Dev-Key', required: false, description: 'Development backends only' })
  send(@Body() dto: OtpSendDto, @Req() req: AuthRequest, @Headers('x-dev-key') key?: string) { return this.identity.sendOtp(dto, req.ip || 'unknown', key); }
  @Public() @Post('public/auth/otp/verify') verify(@Body() dto: OtpVerifyDto) { return this.identity.verifyOtp(dto.challengeId, dto.code); }
  @Public() @Post('public/auth/register') register(@Body() dto: RegisterDto) { return this.identity.register(dto); }
  @Public() @Post('public/auth/login') login(@Body() dto: LoginDto, @Req() req: AuthRequest) { return this.identity.login(dto, req.ip || 'unknown'); }
  @Public() @Post('public/auth/refresh') refresh(@Body() dto: RefreshDto) { return this.identity.refresh(dto.refreshToken); }
  @Public() @Post('public/auth/reset-password') reset(@Body() dto: ResetDto) { return this.identity.resetPassword(dto); }
  @Public() @Post('public/auth/social') social(@Body() dto: SocialDto, @Req() req: AuthRequest) { return this.identity.social(dto.idToken, dto.deviceId, req.ip || 'unknown'); }
  @Public() @Get('dev/otp/:challengeId') @ApiHeader({ name: 'X-Dev-Key', required: true })
  developmentOtp(@Param('challengeId', new ParseUUIDPipe({ version: '4' })) id: string, @Headers('x-dev-key') key?: string) { return this.identity.developmentCode(id, key); }
  @ApiBearerAuth() @Post('auth/logout') logout(@CurrentUser() user: Principal) { return this.identity.logout(user); }
  @ApiBearerAuth() @Get('users/me') me(@CurrentUser() user: Principal) { return this.identity.profile(user.userId); }
  @ApiBearerAuth() @Patch('users/me') update(@CurrentUser() user: Principal, @Body() dto: ProfileDto) { return this.identity.updateProfile(user.userId, dto.displayName); }
  @ApiBearerAuth() @Post('devices/fcm-token') device(@CurrentUser() user: Principal, @Body() dto: DeviceDto) { return this.identity.device(user.userId, dto.deviceId, dto.fcmToken); }
  @ApiBearerAuth() @Delete('users/me/devices/:deviceId') removeDevice(@CurrentUser() user: Principal, @Param('deviceId') id: string) { return this.identity.removeDevice(user.userId, id); }
  @ApiBearerAuth() @Get('users/me/linked-accounts') linked(@CurrentUser() user: Principal) { return this.identity.linkedAccounts(user.userId); }
  @ApiBearerAuth() @Post('users/me/linked-accounts') link(@CurrentUser() user: Principal, @Body() dto: LinkAccountDto) {
    return this.identity.linkAccount(user.userId, dto.idToken, dto.password);
  }
  @ApiBearerAuth() @Delete('users/me/linked-accounts/:id') unlink(@CurrentUser() user: Principal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() dto: ReauthDto) { return this.identity.unlinkAccount(user.userId, id, dto.password); }
  @ApiBearerAuth() @Delete('users/me') deleteAccount(@CurrentUser() user: Principal, @Body() dto: DeleteAccountDto, @Req() req: AuthRequest) {
    return this.identity.requestDeletion(user.userId, dto, req.requestId);
  }
}
