import { Hono } from 'hono'
import type { AppEnv } from '@/env'
import { requireAuth } from '@/middleware/auth'
import applications from '@/routes/admin/applications'
import invitations from '@/routes/admin/invitations'
import roles from '@/routes/admin/roles'
import users from '@/routes/admin/users'

/**
 * Administration API, mounted under `/admin`.
 *
 * Authentication is applied once here; each route then declares the individual permission it needs
 * with `requirePermission`. Guards check permission slugs rather than role names, so a role can be
 * redefined without touching any route.
 */
const app = new Hono<AppEnv>()

app.use('*', requireAuth)

app.route('/', users)
app.route('/', invitations)
app.route('/', applications)
app.route('/', roles)

export default app
