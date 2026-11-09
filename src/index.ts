import { createRelay, type Env } from "./relay";

const relay = createRelay({
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: () => Math.random(),
  // One JSON object per line so Workers Logs can filter on `event`.
  log: (level, data) => (level === "error" ? console.error : console.warn)(JSON.stringify(data)),
});

export default {
  fetch: (request, env) => relay.fetch(request, env),
} satisfies ExportedHandler<Env>;
