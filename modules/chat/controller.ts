import { Body, Controller, Delete, Get, Headers, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { AuthRequest, CurrentUser } from '../../packages/auth/guard';
import { Principal } from '../../packages/auth/tokens';
import { ConversationDto, MessageDto, ReadDto } from './dto';
import { ChatService } from './service';
@ApiTags('chat') @ApiBearerAuth() @Controller()
export class ChatController {
  constructor(private readonly chat: ChatService) {}
  @Post('conversation') create(@CurrentUser() u: Principal, @Body() dto: ConversationDto) { return this.chat.create(u.userId, dto); }
  @Get('conversation') list(@CurrentUser() u: Principal) { return this.chat.list(u.userId); }
  @Post('conversation/:id/accept') accept(@CurrentUser() u: Principal, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) { return this.chat.accept(u.userId, id); }
  @Post('conversation/:id/invite/:userId') invite(@CurrentUser() u: Principal, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('userId', new ParseUUIDPipe({ version: '4' })) target: string) { return this.chat.invite(u.userId, id, target); }
  @Get('conversation/:id/messages') messages(@CurrentUser() u: Principal, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Query('after') after?: string) { return this.chat.messages(u.userId, id, after || '0'); }
  @Post('conversation/:id/read') read(@CurrentUser() u: Principal, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() dto: ReadDto) {
    return this.chat.read(u.userId, id, dto.seq);
  }
  @Post('conversation/:id/message') @ApiHeader({ name: 'Idempotency-Key', required: true })
  send(@CurrentUser() u: Principal, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: MessageDto, @Headers('idempotency-key') key: string | undefined, @Req() req: AuthRequest) {
    return this.chat.send(u.userId, id, dto.body, key, req.requestId);
  }
  @Delete('message/:id') delete(@CurrentUser() u: Principal, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) { return this.chat.deleteMessage(u.userId, id); }
  @Post('message/:id/pin') pin(@CurrentUser() u: Principal, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) { return this.chat.pin(u.userId, id); }
  @Post('crypto/handshake') handshake() { return this.chat.handshake(); }
}
