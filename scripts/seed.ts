import { Pool } from 'pg';
export const demoIds = {
  sport: '10000000-0000-4000-8000-000000000001', shop: '20000000-0000-4000-8000-000000000001',
  branch: '30000000-0000-4000-8000-000000000001', yard: '40000000-0000-4000-8000-000000000001'
};
export async function seed(pool: Pool) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    await tx.query("INSERT INTO catalog.sports(id,name,slug) VALUES($1,'Cầu lông','badminton') ON CONFLICT DO NOTHING", [demoIds.sport]);
    await tx.query("INSERT INTO catalog.shops(id,name) VALUES($1,'Anta Demo') ON CONFLICT DO NOTHING", [demoIds.shop]);
    await tx.query(`INSERT INTO catalog.branches(id,shop_id,name,address,description,location,rules)
      VALUES($1,$2,'Sân cầu lông Demo','Thành phố Hồ Chí Minh','Dữ liệu mẫu, không phải chi nhánh thật.',
      ST_SetSRID(ST_MakePoint(106.660172,10.762622),4326)::geography,'["Mang giày thể thao phù hợp","Đến trước giờ đặt sân 10 phút"]') ON CONFLICT DO NOTHING`, [demoIds.branch, demoIds.shop]);
    await tx.query("INSERT INTO catalog.yards(id,branch_id,sport_id,name,hourly_price) VALUES($1,$2,$3,'Sân 1',180000) ON CONFLICT DO NOTHING", [demoIds.yard, demoIds.branch, demoIds.sport]);
    await tx.query("INSERT INTO catalog.services(id,branch_id,name,price) VALUES('50000000-0000-4000-8000-000000000001',$1,'Thuê vợt',30000) ON CONFLICT DO NOTHING", [demoIds.branch]);
    await tx.query(`INSERT INTO content.documents(slug,title,body) VALUES('terms','Điều khoản bản demo','Bản chạy thử. Thanh toán sandbox không thu tiền thật. Nội dung này chưa phải điều khoản thương mại.') ON CONFLICT DO NOTHING`);
    await tx.query('COMMIT');
  } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
}
if (require.main === module) {
  if (process.env.NODE_ENV === 'production') throw new Error('Demo seed is blocked in production');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  seed(pool).then(() => pool.end()).catch(async error => { console.error(`Demo seed failed: ${error instanceof Error ? error.message : 'unknown error'}`); await pool.end(); process.exitCode = 1; });
}
