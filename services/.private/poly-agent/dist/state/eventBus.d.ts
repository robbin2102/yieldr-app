import { EventEmitter } from 'events';
export declare const eventBus: EventEmitter<[never]>;
export type EventType = 'trade:detected' | 'trade:executing' | 'trade:filled' | 'trade:failed' | 'trade:skipped';
