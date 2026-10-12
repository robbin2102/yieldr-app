import { readScanOutput } from "@/lib/edge/scan-results";
import { response } from "@/lib/edge/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  _: Request,
  { params }: { params: Promise<{ scanId: string }> },
) {
  return response(async () => readScanOutput((await params).scanId,"holdings"));
}
