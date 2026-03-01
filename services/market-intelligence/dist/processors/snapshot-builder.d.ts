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
/**
 * Merge TAAPI + CoinGlass data into a market_snapshots document and upsert to MongoDB.
 */
export declare function buildAndSaveSnapshot(args: BuildSnapshotArgs): Promise<void>;
export {};
