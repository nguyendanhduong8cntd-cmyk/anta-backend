import { CanActivate, createParamDecorator, ExecutionContext, Global, Injectable, Module, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { Database, DatabaseModule } from '../database';
import { loadConfig } from '../config';
import { verifyAccess, Principal } from './tokens';
import { ApiError } from '../contracts/errors';
export type AuthRequest = Request & { principal: Principal; requestId: string };
export const Public = () => SetMetadata('public', true);
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): Principal => ctx.switchToHttp().getRequest<AuthRequest>().principal);
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly db: Database) {}
  async canActivate(ctx: ExecutionContext) {
    if (this.reflector.getAllAndOverride<boolean>('public', [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest<AuthRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new ApiError('UNAUTHORIZED', 'Authentication required', 401);
    let principal: Principal;
    try { principal = await verifyAccess(header.slice(7), loadConfig().jwtSecret); }
    catch { throw new ApiError('UNAUTHORIZED', 'Invalid or expired access token', 401); }
    const session = await this.db.query(`SELECT 1 FROM identity.refresh_sessions s JOIN identity.users u ON u.id=s.user_id
      WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.status='ACTIVE'`, [principal.sessionId, principal.userId]);
    if (!session.rowCount) throw new ApiError('UNAUTHORIZED', 'Session has been revoked', 401);
    req.principal = principal;
    return true;
  }
}
@Global()
@Module({ imports: [DatabaseModule], providers: [AuthGuard], exports: [AuthGuard] })
export class AuthModule {}
