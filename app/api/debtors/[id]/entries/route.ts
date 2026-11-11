import { getCollections } from '@/lib/db';
import { ApiError, json, readJson, requireAdmin, requireMutation, route } from '@/lib/http';
import { checkEntryWritable, todayInTimeZone, watermarkOf } from '@/lib/ledger';
import { findDebtorById, loadLedger, toObjectId } from '@/lib/service';
import { parseAmount, parseEntryDate, parseMonthParam, parseString } from '@/lib/validate';
import type { EntryDoc } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/** GET /api/debtors/:id/entries?month=YYYY-MM */
export const GET = route<Context>(async (request, context) => {
  await requireAdmin(request);
  const { id } = await context.params;
  const url = new URL(request.url);
  return json(await loadLedger(id, parseMonthParam(url.searchParams.get('month'))));
});

/** POST /api/debtors/:id/entries — thêm khoản phát sinh. */
export const POST = route<Context>(async (request, context) => {
  await requireAdmin(request);
  requireMutation(request);

  const { id } = await context.params;
  const debtor = await findDebtorById(id);

  const body = await readJson(request);
  const today = todayInTimeZone();
  const date = parseEntryDate(body.date, today);
  const category = parseString(body.category, { field: 'Danh mục', max: 60, required: true });
  const amount = parseAmount(body.amount);
  const note = parseString(body.note, { field: 'Ghi chú', max: 500 });

  if (amount === 0) throw new ApiError(400, 'INVALID_AMOUNT', 'Số tiền không được bằng 0');

  const { entries, settlements } = await getCollections();
  const settlementDocs = await settlements
    .find({ debtorId: debtor._id })
    .project<{ periodEnd: string; status: 'active' | 'void' }>({ periodEnd: 1, status: 1 })
    .toArray();
  const watermark = watermarkOf(settlementDocs);
  const guard = checkEntryWritable(date, watermark);
  if (!guard.ok) throw new ApiError(409, guard.code, guard.message);

  const now = new Date();
  const doc: Omit<EntryDoc, '_id'> = {
    debtorId: toObjectId(id),
    date,
    category,
    amount,
    note,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  const result = await entries.insertOne(doc as EntryDoc);

  return json(
    {
      entry: {
        id: result.insertedId.toString(),
        date,
        category,
        amount,
        note,
        editable: true,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    },
    { status: 201 },
  );
});
