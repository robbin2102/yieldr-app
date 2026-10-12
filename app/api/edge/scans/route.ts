import { createScan } from "@/lib/edge/scans";
import { response, rateLimit, readWalletRequest } from "@/lib/edge/http";
import { walletInput } from "@/lib/edge/domain";
import { EdgeError } from "@/lib/edge/config";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  return response(async () => {
    const {wallet,forceFresh} = await readWalletRequest(request);
    if (!walletInput(wallet)) throw new EdgeError("invalid_wallet", 400);
    await rateLimit(request);
    return createScan(wallet,forceFresh);
  });
}
