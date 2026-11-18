import { json, readJson, requireAdmin, requireMutation, route } from '@/lib/http';
import { deleteCategory, updateCategory } from '@/lib/service';
import { parseAmount, parseString } from '@/lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/** PATCH /api/categories/:id — đổi tên hoặc đơn giá. */
export const PATCH = route<Context>(async (request, context) => {
  await requireAdmin(request);
  requireMutation(request);

  const { id } = await context.params;
  const body = await readJson(request);
  const patch: { name?: string; unitPrice?: number } = {};

  if ('name' in body) patch.name = parseString(body.name, { field: 'Tên danh mục', max: 60, required: true });
  if ('unitPrice' in body) patch.unitPrice = Math.abs(parseAmount(body.unitPrice));

  return json({ category: await updateCategory(id, patch) });
});

/** DELETE /api/categories/:id — xoá khỏi danh sách chung. */
export const DELETE = route<Context>(async (request, context) => {
  await requireAdmin(request);
  requireMutation(request);

  const { id } = await context.params;
  await deleteCategory(id);
  return json({ ok: true, deletedId: id });
});
