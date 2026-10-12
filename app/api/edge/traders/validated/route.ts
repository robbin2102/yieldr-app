import { validatedTraders } from "@/lib/edge/repository";
import { response } from "@/lib/edge/http";
import { EdgeError } from "@/lib/edge/config";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return response(async () => {
    const raw = new URL(request.url).searchParams.get("limit") || "3";
    if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 20)
      throw new EdgeError("invalid_limit", 400);
    return { traders: await validatedTraders(Number(raw)) };
  });
}
