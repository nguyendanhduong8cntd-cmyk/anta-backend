import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { AuthRequest, CurrentUser, Public } from '../../packages/auth/guard';
import { Principal } from '../../packages/auth/tokens';
import { BranchFilterDto } from '../../packages/contracts/query';
import { AcceptInvitationDto, BuyTicketDto, CreateEventDto, CreateInvitationDto, CreateMatchDto, CreateTeamDto, MatchResultDto, QrDto } from './dto';
import { SocialService } from './service';
@ApiTags('social') @Controller()
export class SocialController {
  constructor(private readonly social: SocialService) {}
  @Public() @Get('events') events(@Query() q: BranchFilterDto) { return this.social.events(q.branchId); }
  @Public() @Get('branches/:id/events') branchEvents(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) { return this.social.events(id); }
  @Public() @Get('events/:id') event(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) { return this.social.event(id); }
  @ApiBearerAuth() @Post('events') createEvent(@CurrentUser() u: Principal, @Body() dto: CreateEventDto, @Req() req: AuthRequest) { return this.social.createEvent(u.userId, dto, req.requestId); }
  @ApiBearerAuth() @Post('events/:id/tickets') @ApiHeader({ name: 'Idempotency-Key', required: true })
  buyTicket(@CurrentUser() u: Principal, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() dto: BuyTicketDto,
    @Headers('idempotency-key') key: string | undefined, @Req() req: AuthRequest) { return this.social.buyTicket(u.userId, id, dto.contractId, key, req.requestId); }
  @ApiBearerAuth() @Get('users/me/tickets') tickets(@CurrentUser() u: Principal) { return this.social.tickets(u.userId); }
  @ApiBearerAuth() @Post('tickets/scan') scan(@CurrentUser() u: Principal, @Body() dto: QrDto, @Req() req: AuthRequest) { return this.social.scan(u.userId, dto.token, req.requestId); }
  @ApiBearerAuth() @Post('teams') createTeam(@CurrentUser() u: Principal, @Body() dto: CreateTeamDto) { return this.social.createTeam(u.userId, dto.name); }
  @ApiBearerAuth() @Get('users/me/teams') teams(@CurrentUser() u: Principal) { return this.social.teams(u.userId); }
  @ApiBearerAuth() @Post('teams/invitations') invitation(@CurrentUser() u: Principal, @Body() dto: CreateInvitationDto) { return this.social.invitation(u.userId, dto.teamId, dto.maxUses); }
  @ApiBearerAuth() @Post('teams/invitations/accept') accept(@CurrentUser() u: Principal, @Body() dto: AcceptInvitationDto) { return this.social.accept(u.userId, dto.token); }
  @Public() @Get('events/:id/matches') matches(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) { return this.social.matches(id); }
  @ApiBearerAuth() @Post('events/:id/matches') createMatch(@CurrentUser() u: Principal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() dto: CreateMatchDto, @Req() req: AuthRequest) {
    return this.social.createMatch(u.userId, id, dto, req.requestId);
  }
  @ApiBearerAuth() @Post('matches/:id/result') result(@CurrentUser() u: Principal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() dto: MatchResultDto, @Req() req: AuthRequest) {
    return this.social.recordResult(u.userId, id, dto, req.requestId);
  }
}
