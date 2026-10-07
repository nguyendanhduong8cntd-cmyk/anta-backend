import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthRequest, CurrentUser } from '../../packages/auth/guard';
import { Principal } from '../../packages/auth/tokens';
import { CourtPresignDto, PresignDto } from './dto';
import { MediaService } from './service';
@ApiTags('media') @ApiBearerAuth() @Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}
  @Post('presign') presign(@CurrentUser() user: Principal, @Body() dto: PresignDto) {
    return this.media.presign(user.userId, dto);
  }
  @Post(':id/complete') complete(@CurrentUser() user: Principal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) { return this.media.complete(user.userId, id); }
  @Get(':id') get(@CurrentUser() user: Principal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) { return this.media.get(user.userId, id); }
}
@ApiTags('court-images') @ApiBearerAuth() @Controller('branches/:branchId/images')
export class CourtImageController {
  constructor(private readonly media: MediaService) {}
  @Post('presign') presign(@CurrentUser() user: Principal,
    @Param('branchId', new ParseUUIDPipe({ version: '4' })) branchId: string,
    @Body() dto: CourtPresignDto, @Req() req: AuthRequest) {
    return this.media.presignCourt(user.userId, branchId, dto, dto.yardId, req.requestId);
  }
  @Post(':id/complete') complete(@CurrentUser() user: Principal,
    @Param('branchId', new ParseUUIDPipe({ version: '4' })) branchId: string,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Req() req: AuthRequest) {
    return this.media.completeCourt(user.userId, branchId, id, req.requestId);
  }
  @Delete(':id') archive(@CurrentUser() user: Principal,
    @Param('branchId', new ParseUUIDPipe({ version: '4' })) branchId: string,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Req() req: AuthRequest) {
    return this.media.archiveCourt(user.userId, branchId, id, req.requestId);
  }
}
