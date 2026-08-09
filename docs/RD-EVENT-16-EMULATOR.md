# Firebase Emulator Profiling Environment

**RD-EVENT-16.** Runs the entire Event Builder profiling workflow locally — no production
Firestore, no production Auth, no real credentials, no manual account creation.

Builds on [RD-EVENT-14 automation](./RD-EVENT-14-PROFILING-AUTOMATION.md).

---

## Prerequisite: Java

**The Firestore and Storage emulators are JVM processes.** Without Java, `firebase
emulators:start` fails with:

```
Error: Could not spawn `java -version`. Please make sure Java is installed and on your system PATH.
```

Install **JDK 21 or newer** — firebase-tools 15 refuses to start the JVM emulators on
anything older ("no longer supports Java version before 21"). RD-EVENT-16 originally said 17;
that was wrong and fails at startup.

```powershell
winget install EclipseAdoptium.Temurin.21.JDK    # Windows
```

```bash
brew install --cask temurin@21                    # macOS
sudo apt install openjdk-21-jdk                   # Debian/Ubuntu
```

Then open a new shell and confirm `java -version` works.

> The **Auth** emulator is Node-based and runs without Java. Firestore and Storage do not.

---

## Quick start

Four terminals, or four background processes:

```bash
npm run emu:start      # 1. emulators (auth 9099, firestore 8080, storage 9199, UI 4000)
npm run emu:seed       # 2. deterministic organizer + draft
npm run emu:build      # 3. next build --profile
npm run emu:serve      # 4. next start -p 3187
npm run emu:profile    # 5. Playwright scenarios
```

No environment variables to set. Everything comes from `.env.emulator`, which is committed
and contains no real secrets.

Emulator UI: <http://127.0.0.1:4000>

---

## How production and emulator modes coexist

One switch, checked in one place:

```ts
// lib/firebase/emulator.ts
export const USE_FIREBASE_EMULATOR = process.env.NEXT_PUBLIC_FIREBASE_EMULATOR === 'true'
```

**Fail-safe off.** Anything other than the exact string `'true'` — unset, empty, `'1'`,
`'TRUE'` — means production. There is no `NODE_ENV` sniffing and no "looks like localhost"
heuristic, because connecting a production build to an emulator and a test run to production
are both unacceptable outcomes.

It must be a `NEXT_PUBLIC_*` literal read: Next.js only inlines literal
`process.env.NEXT_PUBLIC_X` accesses into the client bundle.

| SDK | Connected in | Guard |
|---|---|---|
| Auth | `lib/firebase/auth/index.ts` | `connectOnce('auth', …)` |
| Firestore | `lib/firebase/firestore/index.ts` | `connectOnce('firestore', …)` |
| Storage | `lib/firebase/storage/index.ts` | `connectOnce('storage', …)` |
| Admin SDK | `lib/firebase/admin.ts` | `FIRESTORE_EMULATOR_HOST` / `FIREBASE_AUTH_EMULATOR_HOST` |

The Admin SDK is guarded on the **emulator host variables** rather than the public flag,
because those variables are what actually redirect the SDK. Keying off anything else could
produce a server that believes it is in emulator mode while writing to production. In
emulator mode it initialises with a project id and **no service account**, which is why
profiling needs no credentials at all.

The project id is `demo-registerdesk`. The `demo-` prefix is special-cased by Firebase
tooling: such a project can never reach a real backend, so a misconfigured run fails loudly
instead of writing to production.

### Switching back

Nothing to undo. `npm run dev`, `npm run build`, and `npm start` read `.env.local` and never
see `NEXT_PUBLIC_FIREBASE_EMULATOR`, so they use production exactly as before.

### Verified in the production bundle

The compiled guard in a production build is:

```js
a = "true" === r.default.env.NEXT_PUBLIC_FIREBASE_EMULATOR
```

With the variable unset it is a runtime read of the client `process.env` shim →
`undefined === "true"` → `false`. **Production never connects to an emulator.**

But note what did *not* happen: Next only inlines `NEXT_PUBLIC_*` values that are **defined
at build time**, so an unset variable is left as a runtime lookup and the emulator branch is
**not dead-code eliminated** — the SDK's `connectAuthEmulator` / `connectFirestoreEmulator` /
`connectStorageEmulator` ship in the client bundle.

To eliminate them, set the flag explicitly in production:

```
NEXT_PUBLIC_FIREBASE_EMULATOR=false
```

in `.env.local` and in your Vercel environment. The comparison then folds to a constant
`false` and the branch is stripped. This is a bundle-size improvement, not a safety fix —
behaviour is already correct either way. `.env.example` documents it.

---

## Seed architecture

`scripts/emulator/seed.mjs`. **Deterministic by construction** — running it twice produces
the same state:

- the auth user is created at a **fixed uid** (`profiling-organizer-uid`); a second run
  updates rather than duplicating
- every document uses `set()` at a **fixed id**, never `add()`
- timestamps are **fixed constants**, never `Date.now()` — a seed whose content changed per
  run would silently change the snapshot payload size, and snapshot cost scales with draft
  size

### Opening on a specific step

`npm run emu:seed` **resets `currentStep` to 0** on every run — that reset is part of what
makes the seed deterministic. To open the draft directly on a wizard step:

```bash
RD_SEED_STEP=7 npm run emu:seed    # opens on Review
```

Indices follow `lib/events/builder/stepRegistry.ts` (standard flow):
`0` eventType · `1` visibility · `2` access · `3` pricing · `4` form · `5` details ·
`6` license · `7` review. Out-of-range or non-numeric values fall back to `0`.

Seeded credentials (emulator-only, safe to publish):

```
profiling@registerdesk.test / ProfilingPassw0rd!
```

The email is created **already verified**. An unverified account is routed to OTP, which the
harness deliberately refuses to bypass.

| Document | Purpose |
|---|---|
| Auth user `profiling-organizer-uid` | Sign-in |
| `users/{uid}` | Organizer profile, `role: 'organizer'` |
| `users/{uid}/eventDrafts/profiling-draft-event` | 6 passes, 20 form fields, 2 KB description |

The draft is sized like a real event on purpose: `writeSnapshot` serialises the **whole**
draft, so a baseline captured on an empty draft does not compare to one captured on a
populated event.

The seed **refuses to run** unless both emulator host variables are set — pointed at
production it would be destructive.

---

## CI

`.github/workflows/profiling.yml` runs the whole workflow on `workflow_dispatch` and weekly.
It installs Temurin 21, starts the emulators, seeds, builds with `--profile`, captures, and
uploads `e2e/.results/` as an artifact.

No secrets. No production project. No external service.

The baseline comparison is `continue-on-error` until a CI baseline is committed to
`docs/baselines/ci`. Making this a required PR check is a deliberate follow-up: durations on
a shared runner are noisy, so gate on **count** metrics (commits, stringify calls,
localStorage writes), which are structural.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Could not spawn java -version` | No JDK | Install Temurin 21, new shell |
| `Refusing to seed: emulator hosts are not set` | Ran the script directly | Use `npm run emu:seed` |
| Port 8080/9099/9199 in use | Stale emulator or other service | `npx firebase-tools emulators:stop`, or change ports in `firebase.json` **and** `lib/firebase/emulator.ts` |
| App still hits production | Flag not `'true'`, or built without `.env.emulator` | `NEXT_PUBLIC_*` is inlined at BUILD time — rebuild with `npm run emu:build` |
| `mode: "development"` in results | Dev server, or another server on the port | `npm run emu:build && npm run emu:serve`; check nothing else holds 3187 |
| All `renderMs` are `0` | Built without `--profile` | `npm run emu:build` |
| Login fails, user not found | Emulators restarted (state is in-memory) | Re-run `npm run emu:seed` |
| Data vanishes between runs | Expected — emulators do not persist by default | Add `--import`/`--export-on-exit` if you want persistence |

---

## Scope

- Emulator state is **in-memory**; restarting clears it. Re-seed after each restart.
  This is intentional — determinism is worth more than persistence for profiling.
- Firestore **rules are loaded** from `firestore.rules`, so the emulator enforces the same
  authorization as production. Auth is not bypassed anywhere.
- Cloud Functions, SES, Razorpay, Meta and R2 are **not** emulated. The Event Builder does
  not call them during the profiled scenarios; a scenario that needs them would require
  additional work.
