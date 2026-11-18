import { json, readJson, requireAdmin, requireMutation, route } from '@/lib/http';
import { createCategory, listCategories } from '@/lib/service';
import { parseAmount, parseString } from '@/lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/categories — danh mục dùng chung (tên + đơn giá). */
export const GET = route(async (request) => {
  await requireAdmin(request);
  return json({ categories: await listCategories() });
});

/** POST /api/categories — thêm danh mục dùng chung. */
export const POST = route(async (request) => {
  await requireAdmin(request);
  requireMutation(request);

  const body = await readJson(request);
  const name = parseString(body.name, { field: 'Tên danh mục', max: 60, required: true });
  const unitPrice = Math.abs(parseAmount(body.unitPrice));

  return json({ category: await createCategory(name, unitPrice) }, { status: 201 });
});
