import "server-only";
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { edgeDb } from "./db";
import { EdgeError } from "./config";

export async function response(fn: () => Promise<unknown>) {
  try {
    return NextResponse.json(await fn(), {
      headers: {
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    const known = e instanceof EdgeError;
    return NextResponse.json(
      { error: known ? e.code : "service_unavailable" },
      {
        status: known ? e.status : 503,
        headers: {
          "Cache-Control": "no-store",
          ...(known && e.status === 429 ? { "Retry-After": "60" } : {}),
        },
      },
    );
  }
}
export async function readWalletRequest(request: Request) {
  const origin = request.headers.get("origin");
  if (origin) {
    let host;
    try {
      host = new URL(origin).host;
    } catch {
      throw new EdgeError("invalid_origin", 403);
    }
    if (host !== request.headers.get("host"))
      throw new EdgeError("invalid_origin", 403);
  }
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new EdgeError("invalid_request", 415);
  const reader = request.body?.getReader();
  if (!reader) throw new EdgeError("invalid_request", 400);
  let length = 0;
  const parts: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 1024) {
        await reader.cancel();
        throw new EdgeError("invalid_request", 413);
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const body=JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (body.forceFresh !== undefined && typeof body.forceFresh !== 'boolean') throw new Error('invalid_request');
    return {wallet:body.wallet, forceFresh:body.forceFresh===true};
  } catch {
    throw new EdgeError("invalid_request", 400);
  }
}
export async function rateLimit(request: Request) {
  // Vercel supplies this header at its trusted edge. Other deployments share a conservative bucket.
  const origin = request.headers.get("x-vercel-forwarded-for") || "local";
  const minute = Math.floor(Date.now() / 60000);
  const key =
    "limit:" + createHash("sha256").update(origin).digest("hex") + ":" + minute;
  const db = await edgeDb();
  try {
    await db
      .collection("fomo_analysis_edge_scan_runs")
      .updateOne(
        { _id: key as any, attempts: { $lt: 10 } },
        {
          $inc: { attempts: 1 },
          $setOnInsert: {
            kind: "rate_limit",
            expiresAt: new Date((minute + 2) * 60000),
          },
        },
        { upsert: true },
      );
  } catch (e) {
    if ((e as { code?: number }).code === 11000)
      throw new EdgeError("rate_limited", 429);
    throw e;
  }
}
