import { Hono } from 'hono';
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
export default app;
