import { Injectable } from '@nestjs/common';
import { Database, DbClient } from '../../packages/database';
import { Idempotency } from '../../packages/idempotency';
import { AccessService } from '../../packages/access';
import { invariant } from '../../packages/contracts/errors';
import { emitEvent } from '../../packages/events';
import { orderRefundPercent, RefundService } from '../payment/refunds';
import { CreateOrderDto, CreateVoucherDto, ValidateVoucherDto } from './dto';

@Injectable()
export class CommerceService {
  constructor(private readonly db: Database, private readonly idem: Idempotency, private readonly access: AccessService,
    private readonly refunds: RefundService) {}
  async createVoucher(userId: string, dto: CreateVoucherDto, requestId: string) {
    const from = new Date(dto.validFrom), to = new Date(dto.validTo);
    invariant(Number.isFinite(from.getTime()) && to > from && to.getTime() - from.getTime() <= 366 * 86400000,
      'INVALID_VOUCHER_DATES', 'Voucher dates must span at most one year', 400);
    return this.db.transaction(async tx => {
      await this.access.owner(userId, dto.branchId, tx);
      const row = (await tx.query(`INSERT INTO commerce.vouchers(code,branch_id,amount_off,quota,valid_from,valid_to)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [dto.code, dto.branchId, dto.amountOff, dto.quota, from, to])).rows[0];
      await this.access.audit(tx, userId, 'voucher.create', 'voucher', row.id, requestId);
      return row;
    });
  }
  async validateVoucher(dto: ValidateVoucherDto) {
    const row = (await this.db.query(`SELECT v.*, (SELECT count(*)::int FROM commerce.voucher_redemptions r
      WHERE r.voucher_id=v.id AND r.status IN ('RESERVED','REDEEMED')) AS used
      FROM commerce.vouchers v WHERE v.code=$1 AND v.branch_id=$2 AND v.active AND v.valid_from<=now() AND v.valid_to>now()`,
      [dto.code, dto.branchId])).rows[0];
    invariant(row && row.used < row.quota, 'VOUCHER_UNAVAILABLE', 'Voucher is unavailable');
    return { voucherId: row.id, discount: Math.min(dto.subtotal, row.amount_off), currency: 'VND', available: true };
  }
  async createOrder(userId: string, dto: CreateOrderDto, key: string | undefined, requestId: string) {
    return this.idem.run(userId, 'order', key, dto, async tx => {
      const branch = await tx.query('SELECT 1 FROM catalog.branches WHERE id=$1', [dto.branchId]);
      invariant(branch.rowCount, 'NOT_FOUND', 'Branch not found', 404);
      const unique = new Set(dto.items.map(item => item.serviceId));
      invariant(unique.size === dto.items.length, 'DUPLICATE_SERVICE', 'Combine duplicate services into one item', 400);
      const catalog = (await tx.query('SELECT id,price,currency FROM catalog.services WHERE branch_id=$1 AND id=ANY($2::uuid[])',
        [dto.branchId, [...unique]])).rows;
      invariant(catalog.length === unique.size, 'SERVICE_UNAVAILABLE', 'Service is not available at this branch');
      const prices = new Map(catalog.map(item => [item.id, item]));
      let subtotal = 0;
      for (const item of dto.items) subtotal += prices.get(item.serviceId).price * item.quantity;
      invariant(Number.isSafeInteger(subtotal) && subtotal <= 1000000000 && subtotal > 0, 'INVALID_ORDER_AMOUNT', 'Order amount is invalid', 400);
      let voucher: any = null, discount = 0;
      if (dto.voucherCode) {
        voucher = (await tx.query('SELECT * FROM commerce.vouchers WHERE code=$1 AND branch_id=$2 FOR UPDATE', [dto.voucherCode, dto.branchId])).rows[0];
        invariant(voucher?.active && voucher.valid_from.getTime() <= Date.now() && voucher.valid_to.getTime() > Date.now(),
          'VOUCHER_UNAVAILABLE', 'Voucher is unavailable');
        const used = (await tx.query("SELECT count(*)::int AS n FROM commerce.voucher_redemptions WHERE voucher_id=$1 AND status IN ('RESERVED','REDEEMED')", [voucher.id])).rows[0].n;
        invariant(used < voucher.quota, 'VOUCHER_UNAVAILABLE', 'Voucher quota is exhausted');
        discount = Math.min(subtotal, voucher.amount_off);
      }
      const amount = subtotal - discount, status = amount === 0 ? 'CONFIRMED' : 'PENDING_PAYMENT';
      const order = (await tx.query(`INSERT INTO commerce.orders(user_id,branch_id,subtotal,discount,amount,voucher_id,status,payment_expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '10 minutes') RETURNING *`,
        [userId, dto.branchId, subtotal, discount, amount, voucher?.id || null, status])).rows[0];
      for (const item of dto.items) {
        const price = prices.get(item.serviceId).price;
        await tx.query(`INSERT INTO commerce.order_items(order_id,service_id,quantity,unit_price,total)
          VALUES($1,$2,$3,$4,$5)`, [order.id, item.serviceId, item.quantity, price, price * item.quantity]);
      }
      if (voucher) await tx.query('INSERT INTO commerce.voucher_redemptions(voucher_id,order_id,user_id,status) VALUES($1,$2,$3,$4)',
        [voucher.id, order.id, userId, amount === 0 ? 'REDEEMED' : 'RESERVED']);
      await tx.query('INSERT INTO commerce.order_history(order_id,to_status,reason,actor_id) VALUES($1,$2,$3,$4)', [order.id, status, 'checkout', userId]);
      await emitEvent(tx, userId, `order.${status.toLowerCase()}`, { orderId: order.id, status }, requestId);
      return { ...order, items: dto.items.map(item => ({ ...item, unitPrice: prices.get(item.serviceId).price })) };
    });
  }
  async get(userId: string, id: string, tx: DbClient = this.db.pool) {
    const row = (await tx.query('SELECT * FROM commerce.orders WHERE id=$1 AND user_id=$2', [id, userId])).rows[0];
    invariant(row, 'NOT_FOUND', 'Order not found', 404);
    return row;
  }
  async list(userId: string) {
    return (await this.db.query('SELECT * FROM commerce.orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100', [userId])).rows;
  }
  async lock(tx: DbClient, id: string) {
    const row = (await tx.query('SELECT * FROM commerce.orders WHERE id=$1 FOR UPDATE', [id])).rows[0];
    invariant(row, 'NOT_FOUND', 'Order not found', 404);
    return row;
  }
  async transition(tx: DbClient, row: any, to: 'CONFIRMED' | 'CANCELLED' | 'EXPIRED', reason: string, actorId?: string, requestId?: string) {
    invariant(row.status === 'PENDING_PAYMENT' || (row.status === 'CONFIRMED' && to === 'CANCELLED'),
      'INVALID_ORDER_TRANSITION', 'Order cannot change from its current status');
    await tx.query('UPDATE commerce.orders SET status=$2,updated_at=now(),version=version+1 WHERE id=$1', [row.id, to]);
    await tx.query('INSERT INTO commerce.order_history(order_id,from_status,to_status,reason,actor_id) VALUES($1,$2,$3,$4,$5)',
      [row.id, row.status, to, reason, actorId || null]);
    if (row.voucher_id) await tx.query('UPDATE commerce.voucher_redemptions SET status=$2 WHERE order_id=$1', [row.id, to === 'CONFIRMED' ? 'REDEEMED' : 'RELEASED']);
    await emitEvent(tx, row.user_id, `order.${to.toLowerCase()}`, { orderId: row.id, status: to }, requestId);
    row.status = to;
    return row;
  }
  async confirm(tx: DbClient, row: any, requestId: string) {
    if (row.status !== 'PENDING_PAYMENT' || row.payment_expires_at.getTime() <= Date.now()) return false;
    await this.transition(tx, row, 'CONFIRMED', 'signed payment webhook', undefined, requestId);
    return true;
  }
  async cancel(userId: string, id: string, key: string | undefined, requestId: string) {
    return this.idem.run(userId, `order-cancel:${id}`, key, { id }, async tx => {
      await this.get(userId, id, tx);
      const row = await this.lock(tx, id);
      if (row.status === 'CANCELLED') return row;
      invariant(row.status === 'PENDING_PAYMENT' || row.status === 'CONFIRMED', 'INVALID_ORDER_TRANSITION', 'Order cannot be cancelled');
      if (row.status === 'PENDING_PAYMENT' || row.amount === 0) return this.transition(tx, row, 'CANCELLED', 'user cancellation', userId, requestId);
      // Paid order: refundable in full for a fixed window after payment.
      const percent = orderRefundPercent(row.updated_at, Date.now(), this.refunds.policy);
      invariant(percent > 0, 'CANCELLATION_WINDOW_CLOSED', 'This order can no longer be cancelled for a refund');
      await this.transition(tx, row, 'CANCELLED', 'user cancellation with refund', userId, requestId);
      const refund = await this.refunds.request(tx, 'order', id, percent, 'order cancelled', requestId);
      return { ...row, refund: refund ? { id: refund.id, amount: refund.amount, percent: refund.percent, status: refund.status } : null };
    });
  }
  async expireDue() {
    const ids = (await this.db.query("SELECT id FROM commerce.orders WHERE status='PENDING_PAYMENT' AND payment_expires_at<=now() LIMIT 100")).rows;
    for (const { id } of ids) await this.db.transaction(async tx => {
      const row = await this.lock(tx, id);
      if (row.status === 'PENDING_PAYMENT' && row.payment_expires_at.getTime() <= Date.now()) await this.transition(tx, row, 'EXPIRED', 'payment deadline elapsed');
    });
    return ids.length;
  }
}
