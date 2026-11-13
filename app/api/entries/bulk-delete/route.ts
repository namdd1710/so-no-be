import type { ObjectId } from 'mongodb';
import { getCollections } from '@/lib/db';
import { ApiError, json, readJson, requireAdmin, requireMutation, route } from '@/lib/http';
import { watermarkOf } from '@/lib/ledger';
import { toObjectId } from '@/lib/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_IDS = 200;

/**
 * POST /api/entries/bulk-delete — xoá mềm nhiều khoản cùng lúc.
 *
 * Body: `{ ids: string[] }`. Khoản thuộc kỳ đã chốt không bị xoá mà trả về
 * trong `skipped` kèm lý do, để UI nói rõ cái nào còn lại.
 */
export const POST = route(async (request) => {
  await requireAdmin(request);
  requireMutation(request);

  const body = await readJson(request);
  const raw = body.ids;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ApiError(400, 'MISSING_IDS', 'Chưa chọn khoản nào để xoá');
  }
  if (raw.length > MAX_IDS) {
    throw new ApiError(400, 'TOO_MANY_IDS', `Mỗi lần chỉ xoá được tối đa ${MAX_IDS} khoản`);
  }

  const ids = raw.map((value) => String(value)).filter((value) => /^[a-f\d]{24}$/i.test(value));
  if (ids.length === 0) throw new ApiError(400, 'MISSING_IDS', 'Danh sách khoản không hợp lệ');

  const { entries, settlements } = await getCollections();
  const docs = await entries.find({ _id: { $in: ids.map(toObjectId) }, deletedAt: null }).toArray();

  // Mỗi con nợ có mốc chốt riêng → tính watermark theo từng con nợ.
  const settlementDocs = docs.length
    ? await settlements
        .find({ debtorId: { $in: [...new Set(docs.map((doc) => doc.debtorId.toString()))].map(toObjectId) } })
        .project<{ debtorId: ObjectId; periodEnd: string; status: 'active' | 'void' }>({
          debtorId: 1,
          periodEnd: 1,
          status: 1,
        })
        .toArray()
    : [];

  const watermarkByDebtor = new Map<string, string | null>();
  for (const doc of docs) {
    const key = doc.debtorId.toString();
    if (watermarkByDebtor.has(key)) continue;
    watermarkByDebtor.set(
      key,
      watermarkOf(settlementDocs.filter((settlement) => settlement.debtorId.toString() === key)),
    );
  }

  const now = new Date();
  const deletable: ObjectId[] = [];
  const skipped: { id: string; reason: string }[] = [];

  for (const doc of docs) {
    const watermark = watermarkByDebtor.get(doc.debtorId.toString()) ?? null;
    if (watermark !== null && doc.date <= watermark) {
      skipped.push({ id: doc._id.toString(), reason: `thuộc kỳ đã chốt đến ${watermark}` });
    } else {
      deletable.push(doc._id);
    }
  }

  if (deletable.length > 0) {
    await entries.updateMany({ _id: { $in: deletable } }, { $set: { deletedAt: now, updatedAt: now } });
  }

  return json({
    deleted: deletable.length,
    skipped,
    skippedCount: skipped.length,
    missing: ids.length - docs.length,
  });
});
