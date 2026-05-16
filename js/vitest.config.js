import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        testTimeout: 300_000,
        hookTimeout: 300_000,
        fileParallelism: false,
        pool: 'forks',
        // singleFork + isolate:false keeps every test file in the same Node process
        // so the fixture's module-level cached Promise is shared — the validator
        // and package deploy happen exactly once for the whole run.
        isolate: false,
        poolOptions: { forks: { singleFork: true } },
        include: ['test/**/*.test.js'],
    },
});
