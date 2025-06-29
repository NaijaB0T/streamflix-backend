// src/routes/internal.ts
import { Hono } from 'hono';
import { Bindings } from '..';

const internal = new Hono<{ Bindings: Bindings }>();

export default internal;
