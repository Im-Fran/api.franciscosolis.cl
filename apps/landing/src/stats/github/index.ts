import { Hono } from 'hono'
import type { Env } from '@/env'
import { describeRoute, resolver } from 'hono-openapi'
import * as v from 'valibot'
import { getGitHubCommits } from '@/stats/github/commits'
import { getGitHubProfile } from '@/stats/github/profile';
import { getGitHubStars } from '@/stats/github/stars';

const app = new Hono<{ Bindings: Env }>()

const indexResponseSchema = v.object({
    code: v.literal(200),
    data: v.object({
        message: v.string(),
        endpoints: v.array(v.string()),
    }),
})

const commitsResponseSchema = v.object({
    code: v.literal(200),
    data: v.number(),
})

const profileResponseSchema = v.object({
    code: v.literal(200),
    data: v.object({
        avatar: v.string(),
        profile_url: v.string(),
        repos: v.object({
            public: v.number(),
            private: v.number(),
            total: v.number(),
        }),
        followers: v.number(),
        location: v.nullable(v.string()),
    }),
})

const starsResponseSchema = v.object({
    code: v.literal(200),
    data: v.number(),
})

app.get(
    '/',
    describeRoute({
        description: 'Listado de endpoints de estadísticas de GitHub disponibles',
        tags: ['GitHub'],
        responses: {
            200: {
                description: 'La GitHub Stats API está operativa',
                content: { 'application/json': { schema: resolver(indexResponseSchema) } },
            },
        },
    }),
    (c) => c.json({
        code: 200,
        data: {
            message: '¡Hello, GitHub Stats API!',
            endpoints: ['/stats/github/commits', '/stats/github/profile', '/stats/github/stars']
        }
    })
);

app.get(
    '/commits',
    describeRoute({
        description: 'Cantidad total de commits del usuario en GitHub',
        tags: ['GitHub'],
        responses: {
            200: {
                description: 'Cantidad de commits',
                content: { 'application/json': { schema: resolver(commitsResponseSchema) } },
            },
        },
    }),
    async (c) => {
        const commits = await getGitHubCommits({ GH_TOKEN: c.env.GH_TOKEN });
        return c.json({
            code: 200,
            data: commits,
        })
    }
)

app.get(
    '/profile',
    describeRoute({
        description: 'Perfil público de GitHub del usuario',
        tags: ['GitHub'],
        responses: {
            200: {
                description: 'Datos del perfil de GitHub',
                content: { 'application/json': { schema: resolver(profileResponseSchema) } },
            },
        },
    }),
    async (c) => {
        const profile = await getGitHubProfile({ GH_TOKEN: c.env.GH_TOKEN });
        return c.json({
            code: 200,
            data: profile,
        })
    }
)

app.get(
    '/stars',
    describeRoute({
        description: 'Cantidad total de estrellas obtenidas en los repositorios propios',
        tags: ['GitHub'],
        responses: {
            200: {
                description: 'Cantidad de estrellas',
                content: { 'application/json': { schema: resolver(starsResponseSchema) } },
            },
        },
    }),
    async (c) => {
        const stars = await getGitHubStars({ GH_TOKEN: c.env.GH_TOKEN });
        return c.json({
            code: 200,
            data: stars,
        })
    }
)

export default app