import { TaapiCoinData } from '../fetchers/taapi';
import { CoinAggregateData, CoinPerCoinData } from '../fetchers/coinglass';
import { BinanceCandleData } from '../fetchers/binance';
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
    binance?: BinanceCandleData;
}
export declare function buildAndSaveSnapshot(args: BuildSnapshotArgs): Promise<void>;
export {};
