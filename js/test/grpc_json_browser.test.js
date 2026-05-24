import { describe, expect, it } from 'vitest';
import EndlessVectorItem from '../EndlessVectorItem.js';

describe('EndlessVectorItem.fromGrpcJson browser decoding', () => {
    it('decodes base64 gRPC JSON without Node Buffer', async () => {
        const originalBuffer = globalThis.Buffer;
        try {
            globalThis.Buffer = undefined;

            const item = EndlessVectorItem.fromGrpcJson({
                bytes: 'AQID',
                meta: 'BAU=',
                blob: null,
            });

            expect([...(await item.bytes())]).toEqual([1, 2, 3]);
            expect([...item.meta]).toEqual([4, 5]);
        } finally {
            globalThis.Buffer = originalBuffer;
        }
    });
});
