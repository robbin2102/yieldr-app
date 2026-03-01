import mongoose from 'mongoose';
export { mongoose };
export declare function connectDB(): Promise<void>;
export declare function disconnectDB(): Promise<void>;
