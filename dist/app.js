import { Hono } from 'hono';
import { serve } from 'inngest/hono';
import { inngest } from './inngest/client.js';
import { geminiTestFunction } from './inngest/gemini-check.js';
import telegram from './telegram.js';
import testAi from './ai-test-route.js';
const app = new Hono();
app.get('/', (c) => {
    return c.text('Hello Railway!');
});
app.get('/marco', (c) => {
    return c.text('polo');
});
app.route('/telegram', telegram);
app.route('/test', testAi);
app.on(['GET', 'POST', 'PUT'], '/api/inngest', serve({ client: inngest, functions: [geminiTestFunction] }));
export default app;
