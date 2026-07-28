# Lakebed Docs Full Text

This file concatenates the current public docs in source order for agents that prefer one fetch.

---
title: Lakebed Docs
source: docs/README.md
url: https://docs.lakebed.dev/
markdown: https://docs.lakebed.dev/index.md
raw: https://docs.lakebed.dev/raw/docs/README.md
---

# Lakebed Docs

Lakebed is an agent-native CLI and runtime for building small full-stack TypeScript apps called capsules.

If you are an agent building with Lakebed, treat the capsule directory as the whole app. Write the server contract, write the Preact client, run the Lakebed CLI, inspect the runtime state, and deploy without leaving code.

## Start Here

Create and run a capsule:

```sh
npx lakebed new my-app --template todo
cd my-app
npx lakebed dev
```

`npx lakebed create` is an alias for `npx lakebed new`. New capsules get a git repository and initial commit unless they are created inside an existing git repository or `--no-git` is passed.

A Lakebed v0 capsule has this shape:

```txt
server/index.ts
client/index.tsx
shared/
.env.lakebed.server
```

- `server/index.ts`: schema, queries, mutations, and external endpoints. Import only from `lakebed/server` and pure relative files.
- `client/index.tsx`: the Preact UI entrypoint. Import hooks and auth UI from `lakebed/client`.
- `shared/`: pure TypeScript shared by server and client. Do not import Lakebed runtimes, DOM APIs, Node built-ins, secrets, or env values here.
- `.env.lakebed.server`: optional server-only environment variables exposed to server handlers through `ctx.env`.

## Server Contract

Every capsule exports a default `capsule()` definition from `server/index.ts`.

```ts
import { capsule, endpoint, json, mutation, query, string, table, text } from "lakebed/server";

export default capsule({
  schema: {
    messages: table({
      body: string(),
      authorId: string()
    })
  },

  queries: {
    messages: query((ctx) =>
      ctx.db.messages
        .where("authorId", ctx.auth.userId)
        .orderBy("createdAt", "desc")
        .all()
    )
  },

  mutations: {
    sendMessage: mutation((ctx, body: string) =>
      ctx.db.messages.insert({
        body,
        authorId: ctx.auth.userId
      })
    )
  },

  endpoints: {
    webhook: endpoint({ method: "POST", path: "/webhooks/incoming" }, async (ctx, req) => {
      if (req.headers.get("x-webhook-secret") !== ctx.env.WEBHOOK_SECRET) {
        return text("unauthorized", { status: 401 });
      }

      const payload = await req.json<{ body: string }>();
      ctx.db.messages.insert({
        body: payload.body,
        authorId: "webhook"
      });

      return json({ ok: true });
    })
  }
});
```

Server handlers receive:

- `ctx.auth`: the current guest or Google identity.
- `ctx.db`: typed table access with `where`, `orderBy`, `limit`, `all`, `get`, `insert`, `update`, and `delete`.
- `ctx.env`: server-only values from `.env.lakebed.server`.
- `ctx.log`: structured logs captured by the runtime.

Make queries and mutations server-authoritative. Filter rows by `ctx.auth.userId` when data belongs to a user, and re-check ownership inside mutations before updates or deletes. Anonymous deploys run the bundled server JavaScript in a restricted source runtime by default, so ordinary JavaScript authorization checks stay authoritative.

Use `endpoints` for webhooks and external services. Endpoint handlers receive the same `ctx` as queries and mutations plus a request object with `headers`, `query`, `text()`, `json()`, and `bytes()`.

## Client Contract

The client exports `App` from `client/index.tsx`.

```tsx
import { SignInWithGoogle, signOut, useAuth, useMutation, useQuery } from "lakebed/client";

type Message = {
  id: string;
  body: string;
  authorId: string;
  createdAt: string;
  updatedAt: string;
};

export function App() {
  const auth = useAuth();
  const messages = useQuery<Message[]>("messages");
  const sendMessage = useMutation<[body: string], void>("sendMessage");

  return (
    <main className="min-h-screen bg-black p-6 text-white">
      {auth.isLoading ? (
        <span>Checking session</span>
      ) : auth.isGuest ? (
        <SignInWithGoogle />
      ) : (
        <button className="inline-flex items-center gap-2" type="button" onClick={() => signOut()}>
          {auth.picture ? <img alt="" className="h-6 w-6 rounded-full" referrerPolicy="no-referrer" src={auth.picture} /> : null}
          Sign out {auth.displayName}
        </button>
      )}

      <button type="button" onClick={() => void sendMessage("hello")}>
        Send
      </button>

      <pre>{JSON.stringify(messages, null, 2)}</pre>
    </main>
  );
}
```

- `useQuery<T>("name")` subscribes to a server query.
- `useMutation<TArgs, TResult>("name")` calls a server mutation and returns a promise.
- `useAuth()` reads the current client identity. Use `auth.isLoading` to avoid showing signed-out UI while Lakebed confirms a stored session.
- `<SignInWithGoogle />`, `signInWithGoogle()`, and `signOut()` provide the built-in Google auth path.
- Use `<Router>`, `<Routes>`, `<Route>`, `<Link>`, `useParams()`, `useLocation()`, and `useNavigate()` for client-side pages.
- Use Tailwind classes directly in JSX. V0 does not have CSS files, CSS modules, PostCSS, or a Tailwind build step.

Client routes are app-relative and work in dev and hosted deploys:

```tsx
import { Link, Route, Router, Routes, useParams } from "lakebed/client";

function ItemPage() {
  const { id } = useParams<{ id: string }>();
  return <main>Item {id}</main>;
}

export function App() {
  return (
    <Router>
      <Link to="/items/123">Open item</Link>
      <Routes>
        <Route path="/" element={<main>Home</main>} />
        <Route path="/items/:id" element={<ItemPage />} />
        <Route path="*" element={<main>Not found</main>} />
      </Routes>
    </Router>
  );
}
```

Use server `endpoints` for HTTP APIs and webhooks. If a `GET` endpoint and a client route use the same path, the endpoint handles direct HTTP requests first.

## Auth And Env

Every app starts with guest auth. In dev, set the current global guest identity with:

```sh
npx lakebed auth as alice
```

For per-tab identities, add `?lakebed_guest=alice` or `?lakebed_guest=bob` to the app URL.

Server-only env belongs in `.env.lakebed.server`:

```txt
OPENAI_API_KEY=sk-...
STRIPE_WEBHOOK_SECRET=whsec_...
```

Read it only from server handlers:

```ts
queries: {
  settings: query((ctx) => ({
    hasOpenAiKey: Boolean(ctx.env.OPENAI_API_KEY)
  }))
}
```

`npx lakebed dev` loads server env locally. Hosted server env syncs only after a deploy is claimed, and deploy sync replaces the hosted env with the file contents. Env values are not exposed to client code or embedded in anonymous artifacts.

## Inspect The Runtime

While `npx lakebed dev` is running:

```sh
npx lakebed db list --port 3000
npx lakebed db dump --port 3000
npx lakebed logs --port 3000
```

For hosted or locally deployed apps, pass a deploy id or URL:

```sh
npx lakebed inspect <deploy-id-or-url>
npx lakebed db dump <deploy-id-or-url>
npx lakebed logs <deploy-id-or-url>
```

Use these before guessing. Local `npx lakebed dev` inspection is open on localhost. Hosted deploys keep app manifests, state, table names, logs, and usage private by default. The CLI sends developer auth for a committed `lakebed.json` binding or reads the saved anonymous claim token from `.lakebed/deploy.json`. Non-private hosted manifests expose only the app name, deploy id, client bundle hash, and runtime version.

## Deploy

From inside a capsule:

```sh
npx lakebed deploy
```

Anonymous deploys work first. Claim the deploy when the app needs hosted server env or outbound server-side `fetch`, then run `npx lakebed deploy` again. Anonymous deploys do not rewrite guarded JavaScript mutations into weaker IR.

For a portable owned deploy, run `npx lakebed auth login` before the first deploy. Lakebed writes a root-level `lakebed.json` containing only `deployId`; commit it so fresh checkouts update the same app. Create a deploy-scoped CI credential with `npx lakebed token create --name github-actions`, or create an owner-wide credential with `npx lakebed token create --personal --name local-automation`. When using a custom `--api`, set `LAKEBED_TOKEN_API` to the same canonical origin before supplying `LAKEBED_TOKEN`. The canonical origin is the scheme and host, plus a port when it is non-standard, without a path or query. For example, with `--api https://api.example.com`, set `LAKEBED_TOKEN_API=https://api.example.com`.

Inspection for hosted deploys is private by default. For demos where public data and logs are intentional, deploy with:

```sh
npx lakebed deploy --public-inspect
```

Repository contributors can start the private hosted workspace for local deploy testing:

```sh
pnpm --filter @lakebed/hosted start
npx lakebed deploy --api http://localhost:8787
```

After a hosted deploy is claimed, reserve a Lakebed-owned app subdomain from the capsule directory:

```sh
npx lakebed domains add my-app.lakebed.app
```

## Current Limits

- One server entry: `server/index.ts`.
- One client entry: `client/index.tsx`.
- App code can use relative imports, `lakebed/server`, `lakebed/client`, and Lakebed-provided Preact modules.
- Arbitrary npm imports inside capsule code are not supported yet.
- Node built-ins are not available inside capsule modules.
- Local state resets when `npx lakebed dev` restarts.
- File storage is not part of v0.
- Anonymous deploys disable outbound server-side `fetch`.
- Non-empty `.env.lakebed.server` files require a claimed deploy before hosted env can sync.

## Read Next

- [`capsule-api.md`](./capsule-api.md): detailed app-author API.
- [`reference.md`](./reference.md): capsule runtime, API, CLI, and deploy reference.
- [`examples`](../examples): working capsules that show the intended app shape.
- [`docs.json`](/docs.json), [`llms.txt`](/llms.txt), and [`llms-full.txt`](/llms-full.txt): machine-readable docs entrypoints.


---
title: Lakebed Reference
source: docs/reference.md
url: https://docs.lakebed.dev/reference/
markdown: https://docs.lakebed.dev/reference/index.md
raw: https://docs.lakebed.dev/raw/docs/reference.md
---

# Lakebed Reference

Use this as the quick contract when building a Lakebed capsule.

## Capsule

A capsule is one complete Lakebed app: source, server API, client UI, state, auth, logs, and deploy URL.

V0 expects this directory shape:

```txt
server/index.ts
client/index.tsx
shared/
.env.lakebed.server
```

- `server/index.ts` exports the capsule definition.
- `client/index.tsx` exports the Preact `App` component.
- `shared/` contains pure TypeScript used by both sides.
- `.env.lakebed.server` is optional server-only configuration.

There is no `lakebed.config.ts` in v0.

## Module Boundaries

- Server code imports from `lakebed/server`.
- Client code imports from `lakebed/client`.
- Shared code imports only pure relative TypeScript.
- App code can import relative files and Lakebed-provided Preact modules.
- App code cannot import arbitrary npm packages yet.
- Capsule modules cannot use Node built-ins.
- Shared code must not read env, secrets, DOM APIs, Node APIs, or Lakebed runtime APIs.

## Server API

```ts
import { boolean, capsule, mutation, query, string, table } from "lakebed/server";
```

Export one default `capsule()` call:

```ts
export default capsule({
  schema: {
    todos: table({
      text: string(),
      done: boolean().default(false),
      ownerId: string()
    })
  },
  queries: {
    todos: query((ctx) =>
      ctx.db.todos
        .where("ownerId", ctx.auth.userId)
        .orderBy("createdAt", "desc")
        .all()
    )
  },
  mutations: {
    addTodo: mutation((ctx, text: string) =>
      ctx.db.todos.insert({
        text,
        done: false,
        ownerId: ctx.auth.userId
      })
    )
  }
});
```

Server handlers receive:

- `ctx.auth`: current identity.
- `ctx.db`: table access for the capsule database.
- `ctx.env`: server-only env values.
- `ctx.log`: structured logs captured by Lakebed.

## Data API

Tables are declared with `table({ ...fields })`. V0 field helpers are:

- `string()`
- `boolean()`
- `.default(value)` on a field

Every stored row includes:

- `id`
- `createdAt`
- `updatedAt`

Table methods:

- `where(field, value)`: filter rows.
- `orderBy(field, "asc" | "desc")`: sort rows.
- `limit(count)`: cap results.
- `all()`: return rows.
- `get(id)`: return one row or `null`.
- `insert(value)`: create a row.
- `update(id, patch)`: patch a row.
- `delete(id)`: delete a row.

Treat queries and mutations as the source of truth. Filter user-owned data by `ctx.auth.userId`, and re-check ownership inside every mutation that changes or deletes an existing row. Anonymous deploys run bundled server JavaScript in a restricted source runtime by default, so ordinary control flow such as `get(id)` plus `if (!row || row.ownerId !== ctx.auth.userId) return` is preserved instead of approximated by IR.

## External Endpoints

Use `endpoint({ method, path }, handler)` for webhooks and other services that call your app over HTTP.

```ts
import { endpoint, json, text } from "lakebed/server";

endpoints: {
  stripeWebhook: endpoint({ method: "POST", path: "/webhooks/stripe" }, async (ctx, req) => {
    if (req.headers.get("x-webhook-secret") !== ctx.env.STRIPE_WEBHOOK_SECRET) {
      return text("unauthorized", { status: 401 });
    }

    const body = await req.text();
    ctx.log.info("stripe webhook received", { bytes: body.length });
    return json({ ok: true });
  })
}
```

Endpoint handlers receive `ctx.auth`, `ctx.db`, `ctx.env`, and `ctx.log`. The request exposes `method`, `path`, `url`, `headers.get(name)`, `query`, `text()`, `json()`, and `bytes()`. Successful endpoint calls can write to the database and publish subscribed queries. Use `.env.lakebed.server` secrets for webhook checks.

## Client API

```tsx
import {
  Link,
  Route,
  Router,
  Routes,
  SignInWithGoogle,
  navigate,
  signInWithGoogle,
  signOut,
  useAuth,
  useLocation,
  useMutation,
  useNavigate,
  useParams,
  useQuery
} from "lakebed/client";
```

- `useQuery<T>("name")`: subscribe to a server query.
- `useMutation<TArgs, TResult>("name")`: call a server mutation.
- `useAuth()`: read the current client identity. Use `auth.isLoading` to avoid showing signed-out UI while Lakebed confirms a stored session.
- `<SignInWithGoogle />`: render the built-in Google sign-in button.
- `signInWithGoogle()`: start Google sign-in from custom UI.
- `signOut()`: return to guest auth.
- `<Router>`, `<Routes>`, and `<Route>`: render client-side pages.
- `<Link to="/path">`: navigate without a page reload. Paths are app-relative locally and on hosted app subdomains.
- `useParams<T>()`, `useLocation()`, `useNavigate()`, and `navigate()`: read and change the current client route.

Mutation calls return promises:

```tsx
const addTodo = useMutation<[text: string], void>("addTodo");
await addTodo("Ship the app");
```

Router example:

```tsx
function TodoPage() {
  const { id } = useParams<{ id: string }>();
  return <main>Todo {id}</main>;
}

export function App() {
  return (
    <Router>
      <Link to="/todos/123">Open todo</Link>
      <Routes>
        <Route path="/" element={<main>Home</main>} />
        <Route path="/todos/:id" element={<TodoPage />} />
        <Route path="*" element={<main>Not found</main>} />
      </Routes>
    </Router>
  );
}
```

Declared server endpoints take precedence over client routes for direct HTTP requests.

## Auth

Every capsule starts with guest auth.

Set the local guest identity globally:

```sh
npx lakebed auth as alice
```

Set identity per browser tab:

```txt
http://localhost:3000/?lakebed_guest=alice
```

Auth shape on client and server:

```ts
type Auth = {
  userId: string;
  displayName: string;
  provider: "guest" | "google";
  isGuest: boolean;
  isAuthenticated: boolean;
  isLoading?: boolean; // client-only
  email?: string;
  emailVerified?: boolean;
  picture?: string;
};
```

## Server Env

Put server-only values in `.env.lakebed.server`:

```txt
OPENAI_API_KEY=sk-...
```

Read them from server handlers:

```ts
query((ctx) => Boolean(ctx.env.OPENAI_API_KEY));
```

`npx lakebed dev` loads this file locally. Hosted env syncs only after the deploy is claimed. Sync is replace-based: keys removed from `.env.lakebed.server` are removed from the hosted deploy.

Env values are not exposed to client code and are not embedded in anonymous artifacts.

## Styling

Use Tailwind classes directly in JSX.

V0 does not support CSS files, CSS modules, PostCSS, Tailwind config, or a CSS build pipeline.

## Runtime Inspection

While `npx lakebed dev` is running:

```sh
npx lakebed db list --port 3000
npx lakebed db dump --port 3000
npx lakebed logs --port 3000
```

For a deployed app:

```sh
npx lakebed inspect <deploy-id-or-url>
npx lakebed db list <deploy-id-or-url>
npx lakebed db dump <deploy-id-or-url>
npx lakebed logs <deploy-id-or-url>
```

Local state is in-memory and resets when `npx lakebed dev` restarts.

Local inspection is open on localhost. Hosted inspection is private by default for manifests, table names, row dumps, logs, and usage. Run hosted inspection commands from the capsule directory so the CLI can find `lakebed.json` or `.lakebed/deploy.json` in the working directory tree and send developer auth from the binding or saved anonymous claim token. Direct HTTP callers can use `Authorization: Bearer <token>`. Non-private hosted manifests expose only app name, deploy id, client bundle hash, and runtime version.

## CLI

```sh
npx lakebed new [name] [--template todo] [--no-git]
npx lakebed create [name] [--template todo] [--no-git]
npx lakebed dev [capsule-dir] [--port 3000]
npx lakebed build [capsule-dir] --target anonymous [--out .lakebed/artifacts/app.json] [--json]
npx lakebed deploy [capsule-dir] [--api <url>] [--public-inspect] [--json]
npx lakebed claim [capsule-dir] [--api <url>] [--json]
npx lakebed auth login [--api <url>] [--json]
npx lakebed auth status [--api <url>] [--json]
npx lakebed auth logout [--api <url>]
npx lakebed token create --name <name> [--personal] [--api <url>] [--json]
npx lakebed token list [--api <url>] [--json]
npx lakebed token revoke <token-id> [--api <url>]
npx lakebed domains add <subdomain.lakebed.app> [--api <url>] [--json]
npx lakebed inspect <deploy-id-or-url> [--api <url>] [--inspect-token <token>] [--json]
npx lakebed run-many [capsule-dir] [--count 20] [--base-port 4000]
npx lakebed auth as <name>
npx lakebed auth reset
npx lakebed db list [deploy-id-or-url] [--port 3000] [--inspect-token <token>]
npx lakebed db dump [deploy-id-or-url] [--port 3000] [--inspect-token <token>]
npx lakebed logs [deploy-id-or-url] [--port 3000] [--inspect-token <token>]
```

## Deploy Behavior

`npx lakebed deploy` can publish an anonymous deploy first.

Claim the deploy before relying on hosted server env or outbound server-side `fetch`, then run `npx lakebed deploy` again. Anonymous deploys intentionally disable those capabilities while preserving server handler control flow in the source runtime.

Run `npx lakebed auth login` before the first deploy to create an owned app. The CLI writes `lakebed.json` at the capsule root with only `deployId`; commit it for fresh-checkout and CI deploys. `npx lakebed token create --name github-actions` returns a deploy-scoped CI credential once. Use `npx lakebed token create --personal --name local-automation` when automation needs an owner-wide credential instead. Supply the returned value as `LAKEBED_TOKEN`. For a custom API origin, `LAKEBED_TOKEN_API` must match the canonical `--api` origin exactly. The canonical origin is the scheme and host, plus a non-standard port when present, without a path or query.

Hosted deploy inspection is `private` by default. Use `npx lakebed deploy --public-inspect` only for demos where making data and logs public is intentional.

Claimed deploys can reserve Lakebed-owned app subdomains with `npx lakebed domains add my-app.lakebed.app`. Reserved product names such as `api`, `admin`, `docs`, and `www` cannot be registered.

Hosted anonymous deploys enforce the advertised state byte limit during mutation commit, cap logs by entry count and bytes, and rate-limit deploy creation, app requests, and app mutations per client on non-local `PUBLIC_ROOT_URL` origins. Forwarded client IP headers are trusted automatically on Railway only when the request comes through Railway's edge proxy; other proxy setups can opt in with `LAKEBED_TRUST_PROXY_HEADERS=1`. Expired unclaimed deploys are marked terminated after `LAKEBED_ANONYMOUS_CLEANUP_GRACE` (default `1h`) and deleted after `LAKEBED_ANONYMOUS_CLEANUP_RETENTION` (default `7d`), including state rows, logs, server env, quota rows, slug mappings, and unreferenced artifacts.


---
title: Capsule API
source: docs/capsule-api.md
url: https://docs.lakebed.dev/capsule-api/
markdown: https://docs.lakebed.dev/capsule-api/index.md
raw: https://docs.lakebed.dev/raw/docs/capsule-api.md
---

# Capsule API

This page shows the API shape an agent should use when authoring a Lakebed app.

## File Layout

```txt
server/index.ts
client/index.tsx
shared/
```

Use `server/index.ts` for schema, queries, mutations, and external endpoints. Use `client/index.tsx` for the Preact UI. Put validation helpers, types, and constants in `shared/` when both sides need them.

## Define The Server

```ts
import { boolean, capsule, mutation, query, string, table } from "lakebed/server";
import { cleanTodoText } from "../shared/todo";

export default capsule({
  schema: {
    todos: table({
      text: string(),
      done: boolean().default(false),
      ownerId: string()
    })
  },

  queries: {
    todos: query((ctx) =>
      ctx.db.todos
        .where("ownerId", ctx.auth.userId)
        .orderBy("createdAt", "desc")
        .all()
    )
  },

  mutations: {
    addTodo: mutation((ctx, text: string) => {
      const cleanText = cleanTodoText(text);
      if (!cleanText) {
        return;
      }

      ctx.db.todos.insert({
        text: cleanText,
        done: false,
        ownerId: ctx.auth.userId
      });
    }),

    setTodoDone: mutation((ctx, id: string, done: boolean) => {
      const todo = ctx.db.todos.get(id);
      if (!todo || todo.ownerId !== ctx.auth.userId) {
        return;
      }

      ctx.db.todos.update(id, { done });
    })
  }
});
```

The important pattern is server authority:

- Queries decide which rows the client can read.
- Mutations validate input before writing.
- Mutations re-check ownership before changing existing rows.
- Client code never writes directly to tables.

Anonymous deploys preserve this model by running the bundled server JavaScript in a restricted source runtime. IR should be treated as a future optimization only when it can preserve the full handler semantics.

## Use Shared Code Carefully

Good shared code:

```ts
export type Todo = {
  id: string;
  text: string;
  done: boolean;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
};

export function cleanTodoText(value: string): string {
  return value.trim().slice(0, 160);
}
```

Keep `shared/` pure. Do not import `lakebed/server`, `lakebed/client`, Preact, DOM APIs, Node built-ins, env values, or secrets from shared files.

## Build The Client

```tsx
import { SignInWithGoogle, signOut, useAuth, useMutation, useQuery } from "lakebed/client";
import { cleanTodoText, type Todo } from "../shared/todo";

export function App() {
  const auth = useAuth();
  const todos = useQuery<Todo[]>("todos");
  const addTodo = useMutation<[text: string], void>("addTodo");
  const setTodoDone = useMutation<[id: string, done: boolean], void>("setTodoDone");
  const authLabel = auth.displayName;
  const authStatus = auth.isLoading && auth.isGuest ? "checking session" : `signed in as ${authLabel}`;

  async function onSubmit(event: SubmitEvent) {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const text = cleanTodoText(String(data.get("text") ?? ""));
    if (!text) {
      return;
    }

    await addTodo(text);
    form.reset();
  }

  return (
    <main className="min-h-screen bg-black px-6 py-10 text-white">
      <section className="mx-auto max-w-2xl">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            {!auth.isLoading && auth.picture ? (
              <img alt="" className="h-7 w-7 rounded-full" referrerPolicy="no-referrer" src={auth.picture} />
            ) : null}
            <p className="min-w-0 truncate font-mono text-sm text-neutral-500">{authStatus}</p>
          </div>
          {!auth.isLoading && auth.isGuest ? (
            <SignInWithGoogle className="border border-neutral-700 px-3 py-1.5 text-sm text-neutral-200" />
          ) : !auth.isLoading ? (
            <button type="button" onClick={() => signOut()}>
              Sign out
            </button>
          ) : null}
        </div>

        <form className="mb-8 flex gap-3" onSubmit={(event) => void onSubmit(event)}>
          <input name="text" className="min-w-0 flex-1 border border-neutral-700 bg-black px-3 py-2" />
          <button type="submit" className="border border-white px-4 py-2">
            Add
          </button>
        </form>

        <ul>
          {todos.map((todo) => (
            <li key={todo.id}>
              <label>
                <input
                  checked={todo.done}
                  type="checkbox"
                  onChange={(event) => void setTodoDone(todo.id, event.currentTarget.checked)}
                />
                {todo.text}
              </label>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
```

Client rules:

- Export `App`.
- Call queries by the names defined in `server/index.ts`.
- Call mutations by the names defined in `server/index.ts`.
- Await mutations when the UI should wait for the server write.
- Use the built-in client router for multiple pages.
- Use Tailwind classes in JSX for styling.

Client routes use Preact components and app-relative paths:

```tsx
import { Link, Route, Router, Routes, useParams } from "lakebed/client";

function TodoPage() {
  const { id } = useParams<{ id: string }>();
  return <main>Todo {id}</main>;
}

export function App() {
  return (
    <Router>
      <Link to="/todos/123">Open todo</Link>
      <Routes>
        <Route path="/" element={<main>Home</main>} />
        <Route path="/todos/:id" element={<TodoPage />} />
        <Route path="*" element={<main>Not found</main>} />
      </Routes>
    </Router>
  );
}
```

Use server endpoints for HTTP APIs and webhooks. If a `GET` endpoint and a client route use the same path, direct HTTP requests hit the endpoint first.

## Auth

Use auth through Lakebed APIs only.

Server:

```ts
ctx.auth.userId;
ctx.auth.displayName;
ctx.auth.picture;
ctx.auth.email;
```

Client:

```tsx
const auth = useAuth();
```

Guest auth is available immediately. To test multiple local users, use separate URLs:

```txt
http://localhost:3000/?lakebed_guest=alice
http://localhost:3000/?lakebed_guest=bob
```

To add Google sign-in, render `<SignInWithGoogle />` or call `signInWithGoogle()` from a custom button. After sign-in, server handlers receive the verified identity on `ctx.auth`.

## Server Env

Add server-only values at the capsule root:

```txt
# .env.lakebed.server
OPENAI_API_KEY=sk-...
```

Read them only from server handlers:

```ts
queries: {
  hasOpenAiKey: query((ctx) => Boolean(ctx.env.OPENAI_API_KEY))
}
```

External endpoints can use the same env binding for webhook secrets:

```ts
import { endpoint, json, text } from "lakebed/server";

endpoints: {
  webhook: endpoint({ method: "POST", path: "/webhooks/incoming" }, async (ctx, req) => {
    if (req.headers.get("x-webhook-secret") !== ctx.env.WEBHOOK_SECRET) {
      return text("unauthorized", { status: 401 });
    }
    return json({ ok: true });
  })
}
```

Do not put secrets in `client/` or `shared/`.

## Run And Inspect

```sh
npx lakebed dev
npx lakebed db list --port 3000
npx lakebed db dump --port 3000
npx lakebed logs --port 3000
```

The database is local and in-memory during `npx lakebed dev`. Restarting dev resets it.

Hosted inspection is private by default. Run hosted inspection commands from the capsule directory so Lakebed can find `lakebed.json` or `.lakebed/deploy.json` in the working directory tree and send developer auth from the binding or saved anonymous claim token. Non-private hosted manifests expose only non-sensitive deploy metadata.

## Deploy

```sh
npx lakebed deploy
```

If the app uses `.env.lakebed.server` or outbound server-side `fetch`, claim the deploy and run `npx lakebed deploy` again so Lakebed can publish the source-backed server path.

For a portable owned deploy, run `npx lakebed auth login` before the first deploy. Commit the generated root-level `lakebed.json`, which contains only the deploy id.

Use `npx lakebed deploy --public-inspect` only for demos where making hosted data and logs public is intentional.


---
title: Lakebed Examples
source: examples/README.md
url: https://docs.lakebed.dev/examples/
markdown: https://docs.lakebed.dev/examples/index.md
raw: https://docs.lakebed.dev/raw/examples/README.md
---

# Lakebed Examples

Use these capsules as patterns for app-building agents. Each example is a complete Lakebed app with the same file layout your generated app should use:

```txt
server/index.ts
client/index.tsx
shared/
```

## What To Copy

- Put schema, queries, and mutations in `server/index.ts`.
- Keep validation helpers and shared types in `shared/`.
- Export `App` from `client/index.tsx`.
- Use `ctx.auth.userId` for user-owned rows.
- Use `useQuery` and `useMutation` rather than inventing a client API.
- Style with Tailwind classes in JSX.

## Examples

- [`todo`](./todo): per-user rows, ownership checks, checkbox mutation, clear-completed mutation.
- [`guestbook`](./guestbook): shared feed, author metadata from auth, bounded text validation.

Run the checked-in todo example:

```sh
npx lakebed dev examples/todo
```

Open separate tabs with different guest identities:

```txt
http://localhost:3000/?lakebed_guest=alice
http://localhost:3000/?lakebed_guest=bob
```


---
title: Todo Example
source: examples/todo/README.md
url: https://docs.lakebed.dev/examples/todo/
markdown: https://docs.lakebed.dev/examples/todo/index.md
raw: https://docs.lakebed.dev/raw/examples/todo/README.md
---

# Todo Example

This capsule shows the smallest useful Lakebed app pattern: authenticated per-user data with server-owned mutations.

## What It Shows

- A `todos` table with `text`, `done`, and `ownerId`.
- A `todos` query filtered by `ctx.auth.userId`.
- An `addTodo` mutation that cleans input before insert.
- A `setTodoDone` mutation that checks row ownership before update.
- A `clearDone` mutation that deletes only the current user's completed rows.
- A Preact UI using `useAuth`, `useQuery`, `useMutation`, and `<SignInWithGoogle />`.
- A pure shared helper for todo text normalization.

## Server Pattern

```ts
queries: {
  todos: query((ctx) =>
    ctx.db.todos
      .where("ownerId", ctx.auth.userId)
      .orderBy("createdAt", "desc")
      .all()
  )
}
```

Use this pattern whenever rows belong to a single user. The client should not receive rows it does not own.

For mutations, fetch the row and check ownership before changing it:

```ts
const todo = ctx.db.todos.get(id);
if (!todo || todo.ownerId !== ctx.auth.userId) {
  return;
}

ctx.db.todos.update(id, { done });
```

## Run It

Run the checked-in example:

```sh
npx lakebed auth as alice
npx lakebed dev examples/todo
```

Open:

```txt
http://localhost:3000
```

To compare two users, open:

```txt
http://localhost:3000/?lakebed_guest=alice
http://localhost:3000/?lakebed_guest=bob
```

Then inspect state:

```sh
npx lakebed db dump --port 3000
npx lakebed logs --port 3000
```


---
title: Guestbook Example
source: examples/guestbook/README.md
url: https://docs.lakebed.dev/examples/guestbook/
markdown: https://docs.lakebed.dev/examples/guestbook/index.md
raw: https://docs.lakebed.dev/raw/examples/guestbook/README.md
---

# Guestbook Example

This capsule shows a shared feed where every signed entry stores author metadata from Lakebed auth.

## What It Shows

- An `entries` table with `body`, `authorId`, `authorName`, and `authorPicture`.
- A shared `entries` query ordered by newest first.
- A `sign` mutation that trims and bounds user input.
- Server-side authorship from `ctx.auth`, not from client-submitted fields.
- A Preact UI using `useAuth`, `useQuery`, `useMutation`, and `<SignInWithGoogle />`.

## Server Pattern

Use shared feeds when every user can read the same rows:

```ts
queries: {
  entries: query((ctx) => ctx.db.entries.orderBy("createdAt", "desc").limit(50).all())
}
```

Still keep writes server-authoritative:

```ts
ctx.db.entries.insert({
  body: trimmed,
  authorId: ctx.auth.userId,
  authorName: ctx.auth.displayName,
  authorPicture: ctx.auth.picture ?? ""
});
```

Do not accept `authorId`, `authorName`, `authorPicture`, or other trusted metadata from the client.

## Run It

Run the checked-in example:

```sh
npx lakebed auth as alice
npx lakebed dev examples/guestbook
```

Open:

```txt
http://localhost:3000
```

To see shared updates from multiple identities, open:

```txt
http://localhost:3000/?lakebed_guest=alice
http://localhost:3000/?lakebed_guest=bob
```

Then inspect state:

```sh
npx lakebed db dump --port 3000
npx lakebed logs --port 3000
```
