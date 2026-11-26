import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
const DEFAULT_PROMPT = 'Give me one short greeting.';
const MAX_PROMPT_LENGTH = 500;
const RUN_TIMEOUT_MS = 60_000;
const matchesKey = (received, expected) => {
    if (!received || !expected)
        return false;
    const receivedBytes = Buffer.from(received);
    const expectedBytes = Buffer.from(expected);
    return (receivedBytes.length === expectedBytes.length &&
        timingSafeEqual(receivedBytes, expectedBytes));
};
const testAi = new Hono();
// TEMP: Remove this route after validating Trigger.dev and Gemini.
testAi.get('/ai', async (c) => {
    if (!matchesKey(c.req.query('key'), process.env.TEST_ROUTE_KEY)) {
        return c.json({ error: 'Unauthorized' }, 401);
    }
    const prompt = (c.req.query('prompt')?.trim() || DEFAULT_PROMPT).slice(0, MAX_PROMPT_LENGTH);
    try {
        const { runs, tasks } = await import('@trigger.dev/sdk');
        const handle = await tasks.trigger('test-gemini', {
            prompt,
        });
        const signal = AbortSignal.timeout(RUN_TIMEOUT_MS);
        try {
            for await (const run of runs.subscribeToRun(handle.id, { signal })) {
                if (!run.isCompleted)
                    continue;
                if (!run.isSuccess) {
                    console.error('Gemini test task failed', {
                        runId: run.id,
                        error: run.error,
                    });
                    return c.json({ error: 'The AI test task failed' }, 502);
                }
                const output = run.output;
                if (!output) {
                    console.error('Gemini test task completed without output', {
                        runId: run.id,
                    });
                    return c.json({ error: 'The AI test task returned no result' }, 502);
                }
                if (!output.ok) {
                    return c.json({ error: output.error }, output.statusCode);
                }
                return c.json({ text: output.text });
            }
        }
        catch (error) {
            if (signal.aborted) {
                console.error('Timed out waiting for Gemini test task', {
                    runId: handle.id,
                });
                return c.json({ error: 'The AI test task timed out' }, 504);
            }
            console.error('Failed while waiting for Gemini test task', error);
            return c.json({ error: 'Unable to retrieve the AI test result' }, 502);
        }
        if (signal.aborted) {
            console.error('Timed out waiting for Gemini test task', {
                runId: handle.id,
            });
            return c.json({ error: 'The AI test task timed out' }, 504);
        }
        console.error('Gemini test task subscription ended without a result', {
            runId: handle.id,
        });
        return c.json({ error: 'The AI test task returned no result' }, 502);
    }
    catch (error) {
        console.error('Failed to trigger Gemini test task', error);
        return c.json({ error: 'Unable to start the AI test task' }, 502);
    }
});
export default testAi;
