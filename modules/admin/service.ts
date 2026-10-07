import { Injectable } from '@nestjs/common';
import { Database } from '../../packages/database';
import { AccessService } from '../../packages/access';
import { invariant } from '../../packages/contracts/errors';
import { RoleDto } from './dto';
@Injectable()
export class AdminService {
  constructor(private readonly db: Database, private readonly access: AccessService) {}
  private validate(dto: RoleDto) {
    const global = dto.role === 'admin' || dto.role === 'support';
    invariant(global ? !dto.branchId : Boolean(dto.branchId), 'INVALID_ROLE_SCOPE', 'Role scope is invalid', 400);
  }
  async grant(actorId: string, dto: RoleDto, requestId: string) {
    this.validate(dto);
    return this.db.transaction(async tx => {
      await this.access.admin(actorId, tx);
      const target = await tx.query("SELECT 1 FROM identity.users WHERE id=$1 AND status='ACTIVE'", [dto.userId]);
      invariant(target.rowCount, 'NOT_FOUND', 'Active user not found', 404);
      if (dto.branchId) {
        const branch = await tx.query('SELECT 1 FROM catalog.branches WHERE id=$1', [dto.branchId]);
        invariant(branch.rowCount, 'NOT_FOUND', 'Branch not found', 404);
      }
      await tx.query('INSERT INTO identity.roles(user_id,role,branch_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [dto.userId, dto.role, dto.branchId || null]);
      await this.access.audit(tx, actorId, 'role.grant', 'user', dto.userId, requestId,
        { role: dto.role, branchId: dto.branchId || null });
      return { userId: dto.userId, role: dto.role, branchId: dto.branchId || null, granted: true };
    });
  }
  async revoke(actorId: string, dto: RoleDto, requestId: string) {
    this.validate(dto);
    return this.db.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['admin-role-changes']);
      await this.access.admin(actorId, tx);
      if (dto.role === 'admin') {
        const count = (await tx.query(`SELECT count(*)::int AS n FROM identity.roles r
          JOIN identity.users u ON u.id=r.user_id WHERE r.role='admin' AND u.status='ACTIVE'`)).rows[0].n;
        invariant(count > 1, 'LAST_ADMIN', 'Cannot remove the last administrator', 409);
      }
      const result = await tx.query('DELETE FROM identity.roles WHERE user_id=$1 AND role=$2 AND branch_id IS NOT DISTINCT FROM $3::uuid',
        [dto.userId, dto.role, dto.branchId || null]);
      if (result.rowCount) await this.access.audit(tx, actorId, 'role.revoke', 'user', dto.userId, requestId,
        { role: dto.role, branchId: dto.branchId || null });
      return { revoked: Boolean(result.rowCount) };
    });
  }
  async audit(actorId: string) {
    await this.access.admin(actorId);
    return (await this.db.query(`SELECT id,actor_id,action,target_type,target_id,request_id,details,created_at
      FROM platform.audit_events ORDER BY id DESC LIMIT 100`)).rows;
  }
}
