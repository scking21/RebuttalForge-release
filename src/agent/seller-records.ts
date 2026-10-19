import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const SellerRecordSchema = z.object({
  kind: z.enum(["carrier_delivery_scan", "not_shipped", "note"]),
  label: z.string(),
  fact: z.string(),
  recordedAt: z.string(),
  carrier: z.string().optional(),
  trackingNumber: z.string().optional(),
});
export type SellerRecord = z.infer<typeof SellerRecordSchema>;

export type SellerRecordsLoader = (captureId: string) => SellerRecord[];

// <dir>/<capture_id>.json holds an array of SellerRecord. A missing file means
// the seller has no records for that transaction.
export function fileSellerRecords(dir: string): SellerRecordsLoader {
  return (captureId) => {
    if (!/^[A-Za-z0-9_-]+$/.test(captureId)) return [];
    const path = join(dir, `${captureId}.json`);
    if (!existsSync(path)) return [];
    return z.array(SellerRecordSchema).parse(JSON.parse(readFileSync(path, "utf8")));
  };
}
