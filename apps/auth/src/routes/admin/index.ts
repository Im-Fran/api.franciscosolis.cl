import { Hono } from 'hono'
import type { AppEnv } from '@/env'
import { requireAuth } from '@/middleware/auth'
import applications from '@/routes/admin/applications'
import audit from '@/routes/admin/audit'
import avatars from '@/routes/admin/avatars'
import invitations from '@/routes/admin/invitations'
import me from '@/routes/admin/me'
import roles from '@/routes/admin/roles'
import sessions from '@/routes/admin/sessions'
import users from '@/routes/admin/users'

/**
 * Administration API, mounted under `/admin`.
 *
 * Authentication is applied once here; each route then declares the individual permission it needs
 * with `requirePermission`. Guards check permission slugs rather than role names, so a role can be
 * redefined without touching any route.
 *
 * `GET /admin/me` is the exception that declares none: it answers "does this account belong in the
 * administration interface at all", which is the question asked before any panel has been chosen.
 */
const app = new Hono<AppEnv>()

app.use('*', requireAuth)

app.route('/', me)
app.route('/', users)
app.route('/', avatars)
app.route('/', sessions)
app.route('/', invitations)
app.route('/', applications)
app.route('/', roles)
app.route('/', audit)

export default app
