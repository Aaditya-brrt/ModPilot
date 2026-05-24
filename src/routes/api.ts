import { Hono } from 'hono';

export const api = new Hono();

api.get('/health', (c) => c.json({ ok: true }));
