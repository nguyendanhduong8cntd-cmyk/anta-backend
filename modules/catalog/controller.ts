import { Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Public } from '../../packages/auth/guard';
import { Principal } from '../../packages/auth/tokens';
import { BranchQuery } from './dto';
import { CatalogService } from './service';
@ApiTags('catalog') @Controller()
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}
  @Public() @Get('public/sports') sports() { return this.catalog.sports(); }
  @Public() @Get('public/branches') branches(@Query() q: BranchQuery) { return this.catalog.branches(q); }
  @Public() @Get('public/branches/:id') branch(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) { return this.catalog.branch(id); }
  @Public() @Get('public/branches/:id/services') services(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) { return this.catalog.services(id); }
  @ApiBearerAuth() @Get('users/me/favorites') favorites(@CurrentUser() user: Principal) { return this.catalog.favorites(user.userId); }
  @ApiBearerAuth() @Post('users/me/favorites/:id') favorite(@CurrentUser() user: Principal, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) { return this.catalog.favorite(user.userId, id, true); }
  @ApiBearerAuth() @Delete('users/me/favorites/:id') unfavorite(@CurrentUser() user: Principal, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) { return this.catalog.favorite(user.userId, id, false); }
}
