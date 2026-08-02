import { Hono } from 'hono'
import type { Env } from '@/env'
import github from '@/stats/github'

const app = new Hono<{ Bindings: Env }>()

app.route('/github', github)

export default app