import { Hono } from 'hono';
import files from './routes/files';

const app = new Hono();

app.route('/files', files);

export default app;
