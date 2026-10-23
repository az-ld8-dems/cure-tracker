// The Worker in front of the cure tracker. The logic is in app.ts; wrangler.jsonc has the setup.
import { handle } from './app.ts';

export default {
  fetch: (request, env) => handle(request, env),
} satisfies ExportedHandler<Env>;
