import { TaapiCoinData } from '../fetchers/taapi';
import { CoinAggregateData, CoinPerCoinData } from '../fetchers/coinglass';
interface BuildSnapshotArgs {
    symbol: string;
    timestamp: Date;
    tier: 'full' | 'lite';
    taapi: TaapiCoinData;
    aggregate: CoinAggregateData;
    perCoin?: CoinPerCoinData;
    coinbasePremium?: {
        btc: number | null;
        eth: number | null;
    };
}
export declare function buildAndSaveSnapshot(args: BuildSnapshotArgs): Promise<{
    _id: string;
    snapshot: Record<string, unknown>;
}>;
export {};
