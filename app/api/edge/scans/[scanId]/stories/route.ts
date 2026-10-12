import { readScanOutput } from "@/lib/edge/scan-results";
import { response } from "@/lib/edge/http";
import { EdgeError } from "@/lib/edge/config";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ scanId: string }> },
) {
  return response(async () => {
    const raw = new URL(request.url).searchParams.get("offset") || "0";
    if (!/^\d{1,5}$/.test(raw) || Number(raw) > 10000)
      throw new EdgeError("invalid_offset", 400);
    return readScanOutput((await params).scanId,"stories", Number(raw));
  });
}
