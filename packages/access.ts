import { Global, Injectable, Module } from '@nestjs/common';
import { Database, DbClient, DatabaseModule } from './database';
import { invariant } from './contracts/errors';

@Injectable()
export class AccessService {
  constructor(private readonly db: Database) {}
  async staff(userId: string, branchId: string, tx: DbClient = this.db.pool) {
    const allowed = await tx.query(`SELECT 1 FROM identity.roles WHERE user_id=$1
      AND (role='admin' OR (branch_id=$2 AND role IN ('branch_staff','branch_owner'))) LIMIT 1`, [userId, branchId]);
    invariant(allowed.rowCount, 'FORBIDDEN', 'Branch staff permission required', 403);
  }
  async owner(userId: string, branchId: string, tx: DbClient = this.db.pool) {
    const allowed = await tx.query(`SELECT 1 FROM identity.roles WHERE user_id=$1
      AND (role='admin' OR (branch_id=$2 AND role='branch_owner')) LIMIT 1`, [userId, branchId]);
    invariant(allowed.rowCount, 'FORBIDDEN', 'Branch owner permission required', 403);
  }
  async admin(userId: string, tx: DbClient = this.db.pool) {
    const allowed = await tx.query("SELECT 1 FROM identity.roles WHERE user_id=$1 AND role='admin' LIMIT 1", [userId]);
    invariant(allowed.rowCount, 'FORBIDDEN', 'Admin permission required', 403);
  }
  async audit(tx: DbClient, actorId: string, action: string, targetType: string, targetId: string, requestId?: string, details: object = {}) {
    await tx.query(`INSERT INTO platform.audit_events(actor_id,action,target_type,target_id,request_id,details)
      VALUES($1,$2,$3,$4,$5,$6)`, [actorId, action, targetType, targetId, requestId || null, JSON.stringify(details)]);
  }
}
@Global()
@Module({ imports: [DatabaseModule], providers: [AccessService], exports: [AccessService] })
export class AccessModule {}
