import { Hono } from 'hono';
import files from './routes/files';

const app = new Hono();

app.get('/healthz', (c) => c.text('ok'));
app.route('/files', files);

export default app;
