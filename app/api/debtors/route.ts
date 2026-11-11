import { generateAccessCode } from '@/lib/access-code';
import { getCollections } from '@/lib/db';
import { ApiError, fail, json, readJson, requireAdmin, requireMutation, route } from '@/lib/http';
import { listDebtors } from '@/lib/service';
import { parseBooleanish, parseString } from '@/lib/validate';
import type { DebtorDoc } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/debtors — danh sách con nợ + tổng chưa thanh toán từng người. */
export const GET = route(async (request: Request) => {
  await requireAdmin(request);
  const url = new URL(request.url);
  const includeArchived = parseBooleanish(url.searchParams.get('includeArchived')) ?? false;
  const search = parseString(url.searchParams.get('q'), { field: 'Từ khoá', max: 80 });

  const debtors = await listDebtors({ includeArchived, search: search || undefined });
  return json({ debtors });
});

/** POST /api/debtors — tạo con nợ + sinh accessCode MỘT LẦN, cố định. */
export const POST = route(async (request: Request) => {
  await requireAdmin(request);
  requireMutation(request);

  const body = await readJson(request);
  if ('accessCode' in body) {
    throw new ApiError(400, 'ACCESS_CODE_IMMUTABLE', 'Mã truy cập được sinh tự động và không thể thay đổi');
  }

  const name = parseString(body.name, { field: 'Tên con nợ', max: 80, required: true });
  const phone = parseString(body.phone, { field: 'Số điện thoại', max: 30 });
  const note = parseString(body.note, { field: 'Ghi chú', max: 500 });

  const { debtors } = await getCollections();

  // Sinh mã tới khi không trùng (index unique là chốt chặn cuối).
  let created: DebtorDoc | null = null;
  for (let attempt = 0; attempt < 5 && !created; attempt += 1) {
    const doc: Omit<DebtorDoc, '_id'> = {
      name,
      phone: phone || null,
      note: note || null,
      accessCode: generateAccessCode(),
      active: true,
      createdAt: new Date(),
      archivedAt: null,
    };
    try {
      const result = await debtors.insertOne(doc as DebtorDoc);
      created = { ...doc, _id: result.insertedId } as DebtorDoc;
    } catch (error) {
      const code = (error as { code?: number }).code;
      if (code !== 11000) throw error;
    }
  }

  if (!created) return fail(500, 'CODE_COLLISION', 'Không sinh được mã truy cập, vui lòng thử lại');

  return json(
    {
      debtor: {
        id: created._id.toString(),
        name: created.name,
        phone: created.phone,
        note: created.note,
        accessCode: created.accessCode,
        active: created.active,
        createdAt: created.createdAt.toISOString(),
        archivedAt: null,
        unsettled: 0,
        settled: 0,
        lastSettledAt: null,
        entryCount: 0,
      },
    },
    { status: 201 },
  );
});
