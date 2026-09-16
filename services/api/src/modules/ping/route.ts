import type { FastifyPluginAsync } from 'fastify';

const pingResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['ok'],
  properties: {
    ok: { type: 'boolean', const: true },
  },
} as const;

/** Private route implementation owned by the ping module. */
export const pingRoute: FastifyPluginAsync = async (app) => {
  app.get(
    '/api/v1/ping',
    {
      schema: {
        response: { 200: pingResponseSchema },
      },
    },
    async () => ({ ok: true }),
  );
};
