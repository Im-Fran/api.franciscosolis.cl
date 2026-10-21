import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'
import * as v from 'valibot'
import type { AppEnv } from '@/env'
import { requireAdmin } from '@/middleware/admin'
import alerts from '@/panel/routes/alerts'
import apps from '@/panel/routes/apps'
import companies from '@/panel/routes/companies'
import contacts from '@/panel/routes/contacts'
import contracts from '@/panel/routes/contracts'
import diagnostics from '@/panel/routes/diagnostics'
import installations from '@/panel/routes/installations'
import maintenances from '@/panel/routes/maintenances'
import overview from '@/panel/routes/overview'
import releases from '@/panel/routes/releases'
import remote from '@/panel/routes/remote'
import tickets from '@/panel/routes/tickets'
import { dataSchema, jsonContent, panelErrors } from '@/panel/shared'

/**
 * The panel API, mounted at `/v1` — `api.franciscosolis.cl/custom-apps/v1` through the gateway.
 *
 * The gate is applied once here, so no route can be added without it. The version is a path prefix,
 * like the ingest surface's, so a v2 can sit beside it while the panel moves over.
 */
const app = new Hono<AppEnv>()

app.use('*', requireAdmin)

app.get(
  '/me',
  describeRoute({
    description: 'The account behind the access token. The panel\'s "am I signed in, and am I allowed in here" probe.',
    tags: ['Panel'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'The account',
        content: jsonContent(
          dataSchema(
            v.object({
              id: v.string(),
              email: v.string(),
              name: v.nullable(v.string()),
              picture: v.nullable(v.string()),
              roles: v.array(v.string()),
              permissions: v.array(v.string()),
            }),
          ),
        ),
      },
      ...panelErrors,
    },
  }),
  (c) => {
    const admin = c.get('admin')
    return c.json({
      code: 200 as const,
      data: { id: admin.id, email: admin.email, name: admin.name, picture: admin.picture, roles: admin.roles, permissions: admin.permissions },
    })
  },
)

app.route('/', overview)
app.route('/', companies)
app.route('/', contacts)
app.route('/', apps)
app.route('/', installations)
app.route('/', remote)
app.route('/', diagnostics)
app.route('/', alerts)
app.route('/', releases)
app.route('/', contracts)
app.route('/', tickets)
app.route('/', maintenances)

export { app as panel }
