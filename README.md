# Indian Teen Patti — configurable house-rules multiplayer table

A complete, working Teen Patti web app for **virtual chips only**. There are no
payments, deposits or withdrawals anywhere in the codebase.

It ships with:

- Private rooms with invite links / room codes and an administrator.
- A **configurable ranking engine** (not hard-coded Teen Patti rules) with a
  drag-and-drop editor and a test/ordering sandbox.
- Normal and **Muflis** modes, including mid-round Muflis requests.
- Three dealing modes: **three-card**, **two-card + assumed card**, and
  **one-card + shared open card**.
- Full boot vs round boot, blind/seen stakes and counter (raise) rules.
- Showdown tie rules (AA + Ace of Spades, show initiator, split pot).
- Conflict raising and auditable administrator resolution.
- Reconnection, server-side validation, transactional chips, idempotent actions
  and an automated acceptance-test suite.

---

## 1. Quick start

```bash
npm install
npm run dev          # API on :3000, Vite client on :5173
```

Open <http://localhost:5173>, enter a name, then create a private room.

Production build:

```bash
npm run build        # bundles the client into dist/client
npm start            # Express + Socket.IO serves the API and the built client
```

Other scripts:

| Script | Purpose |
| --- | --- |
| `npm run dev` | Server (`tsx watch`) + Vite dev server |
| `npm test` | Vitest acceptance suite (40 tests) |
| `npm run typecheck` | `tsc --noEmit` over client, server, rules and tests |
| `npm run demo` | Adds bots to a room (see below) |

Environment: `PORT` (default `3000`), `DATABASE_FILE` (default `data/teenpatti.db`).

### Playing alone with bots

Teen Patti needs at least two players, so a small helper script can seat bots:

```bash
# 1. grab your token from the browser console:
#    localStorage.getItem('teenpatti.token')
node scripts/demo-bots.mjs <yourToken> 2
# or run it through npm:
npm run demo -- <yourToken> 2
```

The script prints a room code, joins you, and plays the bots (they call, raise
and fold). Options: `MODE=THREE_CARD|TWO_CARD_ASSUMED|ONE_CARD_SHARED`,
`BET_CAP=<n>`.

### Play with a friend (LAN, Tailscale or ngrok)

The whole app (API + sockets + UI) runs on one port, so one URL is all you need:

```bash
npm run build
npm start                       # listens on 0.0.0.0:$PORT (default 3000)
```

#### ngrok (public link, works anywhere)

```bash
ngrok http 3000                 # prints: https://<random>.ngrok-free.app
```

Share that URL. Notes:

- The free plan shows a one-time **"Visit Site"** interstitial to each visitor —
  click it once and the app loads.
- The URL changes on every restart. Add a free static domain in the ngrok
  dashboard and run `ngrok http --url=<your-name>.ngrok-free.app 3000` to keep it.
- ngrok terminates TLS, so the browser gets a **secure context** (clipboard and
  `crypto.randomUUID` work natively).
- Anyone with the link can reach the lobby; the room **code** is the only guard,
  so only share the invite link with your group.

#### Local network / Tailscale (private)

```bash
ipconfig getifaddr en0          # LAN       e.g. 192.168.0.101
tailscale ip -4                 # Tailnet   e.g. 100.90.245.123
```

1. Your friend installs Tailscale, joins your tailnet (or you share the node),
   then opens `http://100.90.245.123:3000`.
2. Dev mode also works: `npm run dev` binds Vite to all interfaces, so the friend
   can use `http://100.90.245.123:5173` (Vite proxies `/api` and `/socket.io` to
   the server on your machine).
3. macOS may ask whether to allow incoming connections for `node` — allow it.
   Tailscale needs no firewall changes; a plain LAN connection does.

Optional HTTPS on Tailscale (nicer, and a secure context):

```bash
tailscale serve --bg 3000       # https://<machine>.<tailnet>.ts.net
```

Do **not** use `tailscale funnel` — that publishes the room to the whole
internet. `serve` keeps it inside your tailnet.

Plain `http://` origins are supported either way: the client falls back to
`crypto.getRandomValues()` for action IDs (`crypto.randomUUID()` is secure-context
only) and the invite-link button falls back to a copy prompt.

---

## 2. Project layout

```
src/rules/          Deterministic rules module — no IO, no framework, no randomness
  cards.ts          Deck, ranks, suits, crypto shuffle, rank patterns
  ranking.ts        Hand classes, category order, overrides, resolution, versioning
  evaluate.ts       Hand evaluation, showdown comparison, assumed-card rules
  betting.ts        Stake machine: blind/seen, raise, counter, fold
  types.ts          Dealing modes, round states, labels
  profiles.ts       Default house profile + required-order fixtures

src/shared/views.ts Wire types shared by server and client (no server imports)

src/server/
  db.ts             SQLite schema (better-sqlite3, WAL)
  game.ts           Authoritative GameService: rooms, rounds, betting, showdown,
                    Muflis, disputes, settlement, per-player views
  index.ts          HTTP API + Socket.IO transport

src/client/         React 18 + Vite single page app
  screens/          Lobby, Table, RankingEditor, Sandbox
  components/       Playing cards
  api.ts            REST + socket helpers
  styles.css        Responsive dark felt UI (desktop and mobile)

tests/              Vitest: ranking.test.ts (rules), game.test.ts (engine)
scripts/            demo-bots.mjs (local bot helper)
```

The rules module is pure: the browser imports **the same** code as the server,
which is why the sandbox can evaluate hands locally without touching a live
table.

---

## 3. Ranking engine

### Hand classes

A hand is an **unordered multiset of ranks** (`A,9,10` = `10,A,9`). Each hand is
classified into one of **741 hand classes** = (`variant`, rank pattern):

| Variant | Count | Notes |
| --- | --- | --- |
| `TRAIL` | 13 | 222 … AAA |
| `PURE_SEQUENCE` | 13 | same-suit run |
| `SEQUENCE` | 13 | mixed-suit run (A-2-3 is lowest, Q-K-A highest) |
| `COLOUR` | 273 | three suiting, not a run |
| `HIGH_CARD` | 273 | three offsuit, not a run |
| `PAIR` | 156 | pair rank × kicker |

A hand containing a **virtual (assumed) card** can only ever be `TRAIL`,
`SEQUENCE`, `PAIR` or `HIGH_CARD` — a virtual card has no suit, so it can never
form a flush or win a suit tie-break.

### Profile = category order + pattern overrides + suit rules

```ts
interface RankingProfile {
  categoryOrder: HandVariant[];                      // trail > pure seq > seq > colour > pair > high
  overrides: { stronger: string; weaker: string }[]; // rank patterns, e.g. "2-3-5" > "14-13-12"
  suitSensitive: boolean;                            // do suits break otherwise equal hands?
  suitOrder: Suit[];                                 // strongest suit first
  muflisTiePolicy: 'UNCHANGED' | 'REVERSE_SUIT';
}
```

### Resolution (one consistent total order)

1. Every hand class gets a **default position** from `categoryOrder` plus the
   intra-category comparator (trail rank, run high card, flush lexicographic,
   pair rank then kicker).
2. Each **rank pattern** gets an *anchor*: the default position of its strongest
   possible hand (so `2-3-5` is anchored by the 2-3-5 colour, not a weak offsuit
   5-high).
3. Anchors are **relaxed along the rule edges** so `235 > AKQ` pulls 235 up next
   to AKQ instead of leaving it in the colour band.
4. A **greedy topological sort** (priority = anchor, tie-break = default
   position) produces the final order. Only user constraints are hard edges, so
   unconstrained hands keep the default order.
5. **Cycles are detected up front** and rejected with a readable message such as
   `The custom rules contradict each other - they form a loop: AKQ > AKJ > A109 > AKQ.`

The resulting order is frozen (with a version fingerprint) into the round when it
starts. Editing a profile only affects subsequent rounds.

With the default house profile the resolved top of the order is:

```
AAA … 333, 222 (Trail), 235 (Colour/High card), AKQ, AKJ, A109, KQJ,
remaining runs, colours, pairs, high cards
```

so `222 > 235 > AKQ > AKJ > A109 > KQJ` holds in Normal mode and reverses exactly
in Muflis.

---

## 4. House rules and configuration

Room rules (editable by the administrator, applied to **subsequent** rounds):

| Rule | Default | Meaning |
| --- | --- | --- |
| `minBoot` | 10 | Room's minimum permitted boot |
| `boot` | 20 | Boot charged per round (clamped to ≥ `minBoot`) |
| `bootMode` | `FULL` | `FULL` = every player pays the boot; `ROUND` = only the player on turn pays |
| `roundBootScope` | `FIRST_TO_ACT` | With `ROUND`: only the first player to act, or each player on their first turn |
| `dealingMode` | `THREE_CARD` | `THREE_CARD` / `TWO_CARD_ASSUMED` / `ONE_CARD_SHARED` |
| `threeCardCompare` | `FULL_HAND` | `FULL_HAND` or `HIGHEST_CARD` (never inferred) |
| `muflisApproval` | `ADMIN` | `ADMIN` or `UNANIMOUS` (all active players) |
| `counterMultiplier` | 3 | A counter pays level × this and raises the level to it |
| `seenMultiple` | 2 | A seen player pays level × this |
| `disputeWindowSeconds` | 15 | Provisional-result window before auto settlement |
| `remainderRule` | `LOWEST_SEAT` | Who gets an indivisible remainder on a split |
| `maxBetsPerRound` | 24 | Safety valve: hands are opened at the cap (0 = off) |
| `startingChips` | 5000 | Virtual chips on joining |

### Betting model

The round tracks the **bet level** (what a blind player puts to pass), the
**last bet** (what the previous player actually paid) and whether that player
was **blind**.

| Situation | Pays | Effect |
| --- | --- | --- |
| Blind player, previous bet was blind (or first bet) | `level` | a **blind pass** — you match, nothing changes |
| Seen player | `level × seenMultiple` (2) — **double** | the level is unchanged, `lastBet` becomes that amount |
| Blind player right after a **seen** bet | the **last bet amount** | it is a **counter**: from then on `level = counterAmount × 3` |
| Explicit counter (any player) | at least your normal requirement | same tripling rule |
| Raise | any amount above the requirement | becomes the new level |

Counters and raises keep repeating, so the level keeps climbing.

Worked example (boot 10, `seenMultiple = 2`, `counterMultiplier = 3`):

| Bet | Player | Pays | Level after | Seen plays now |
| --- | --- | --- | --- | --- |
| 1 | blind | 10 (pass) | 10 | 20 |
| 2 | blind | 10 (pass) | 10 | 20 |
| 3 | blind | 10 (pass) | 10 | 20 |
| 4 | seen | 20 (double) | 20 | 20 |
| 5 | blind → counter | 20 (the current bet) | **60** (3 × 20) | **60** — not 120 |
| 6 | seen | 60 (match) | 60 | 60 |
| 7 | seen | 60 (match) | 60 | 60 |
| 8 | blind → counter | 60 | 180 | 180 |

The doubling only applies while the betting is still blind. Once a seen bet (or a
counter) has been made, everyone matches the level, so a counter is exactly ×3.

`SEE_CARDS` does not consume the turn; `CHAAL`, `RAISE`, `COUNTER` and `FOLD` do.

### Round state machine

```
LOBBY → BOOT → DEALING → BETTING → (SHOW_REQUESTED | MUFLIS_PENDING) →
PROVISIONAL → (DISPUTE) → SETTLED   (VOID is reserved)
```

Every transition is persisted; actions that belong to another state are refused.

---

## 5. Showdown

### Blind play

Your own cards are **not shown at the deal** — server-side, your view contains
face-down placeholders until you press **See cards** (`SEE_CARDS`). That is what
makes blind play real: `blind` only halves your stake, and you cannot choose an
assumed card for a hand you have not looked at (`SEE_CARDS_FIRST`).

### Show rules

- **Full show** — only allowed when **two players are left**. It ends the round:
  both hands are compared and the winner takes the pot.
- **Side show** — allowed while **three or more** players remain. The initiator
  picks an opponent, betting pauses (`SIDE_SHOW_PENDING`), and the opponent
  accepts or declines:
  - decline → betting resumes, nobody folds;
  - accept → the two hands are compared privately, the weaker hand folds, both
    players are treated as having seen their cards, and the round continues;
  - a tie folds nobody.

Only the two participants (and the administrator during a dispute) ever see the
side-show cards, hand classes or the ranked reason. Everybody else sees a single
announcement — *"Bela won the side show — Chetan folded."* — and the public table
log carries no cards or hand classes either (`result` is `null` for outsiders,
`announcement` is always present).

The initiator is stored server side when the request is made — never inferred from
message order.

Evaluation order (both show types):

1. Validate and lock each player's effective hand (a missing assumed card is
   auto-completed with the strongest legal suggestion and logged).
2. Compare with the frozen ranking profile.
3. Reverse hand strength when Muflis is active.
4. AA / Ace-of-Spades rule (assumed-card modes only): when both hands are
   physically AA, the player with the exclusive Ace of Spades wins.
5. Show-initiator rule if still tied in the assumed-card modes.
6. Otherwise split the pot; the remainder goes to the lowest seat (or the show
   initiator, configurable).

`HIGHEST_CARD` mode compares only each player's top card and reverses that
comparison in Muflis.

---

## 6. Conflicts and auditability

- Any player can **Raise conflict** before settlement. Betting and payouts freeze
  (`DISPUTE`).
- The administrator sees every card, assumed card, the ranking version, the mode,
  all bets and the provisional result, then picks **winner / split / void** and
  **must** give an explanation.
- Decisions are written to `disputes`, `actions` and `chip_transactions`.
  Administrator overrides never modify the ranking profile.
- `GET /api/rooms/:id/audit` returns the action log, chip transactions and
  disputes for a room.

Settlement is idempotent: `chip_transactions` has a unique key on
`(round_id, user_id, reason)` and the round state guards re-entry, so a retried
request or a restart can never pay the pot twice. On boot the server re-schedules
or settles any round left in `PROVISIONAL`.

---

## 7. Security and data model

- 52-card deck, no jokers, `crypto.getRandomValues` Fisher–Yates shuffle with
  rejection sampling; a duplicate physical card is an error.
- Opponents' hidden cards are **never** sent to a client before an authorised
  reveal (they are replaced by `{ hidden: true }` placeholders).
- Every action is validated server side, inside a SQLite transaction, with an
  idempotency key per client request.
- Tables: `users`, `sessions`, `ranking_profiles`, `rooms`, `room_members`,
  `rounds` (round document JSON + state), `actions`, `disputes`,
  `chip_transactions`.

---

## 8. Assumptions and interpretations

These are the points where the brief was ambiguous; each is either configurable
or documented here.

1. **Rank-pattern overrides are suit-agnostic** (as the brief assumes). A rule
   like `235 > AKQ` moves *every* hand with pattern 235 (flush or offsuit) above
   every AKQ. Suits only matter inside a hand class, and only when
   `suitSensitive` is on.
2. **`222 > 235`** already held by default (222 is a trail), so that rule is
   recorded but has no effect; it is kept so the mandatory chain is explicit.
3. **`235` is a rank pattern, not a hand category.** It is anchored by its
   strongest possible hand (the 2-3-5 colour), then pulled up by the rule edges.
4. **"Only best of three"** is implemented as the explicit option *full
   three-card hand comparison* (`FULL_HAND`), with a separate, separately named
   *highest single card* option (`HIGHEST_CARD`). The choice is shown on the
   table and never mixed silently.
5. **Boot is charged once per participating player** for `FULL`. For `ROUND`
   boot, the player on turn is charged once: on the first turn only
   (`FIRST_TO_ACT`) or on each player's first turn (`EACH_TURN`).
6. **A player with fewer chips than the boot cannot enter the round.** Ready
   status + chips ≥ boot is the participation rule; everyone must re-ready each
   round.
7. **"Blind" means the player has not declared `SEE_CARDS`.** Your own cards are
   withheld by the server until you press See cards, so blind play is real. The
   blind price only exists for the first bet of a round; every later blind bet is
   a counter (see the betting model above).
8. **Counter** = raise that multiplies the current seen stake by
   `counterMultiplier` (3 by default) and is only legal after at least one bet.
9. **Show is two-player** for the MVP. With more than two active players the
   server rejects the show and explains why.
10. **Assumed card** eligibility uses an explicit numeric scale (Ace high):
    `rank ≤ max(higher physical rank)`. This never depends on the custom ranking
    order. The assumed card may duplicate a physical rank, is never removed from
    the deck, has no suit and cannot create a flush or a spade advantage.
11. **AA tie-break** fires only when both players physically hold AA; a shared
    Ace of Spades benefits everyone, so it grants no exclusive advantage.
12. **Remainder on a split** is deterministic (`LOWEST_SEAT` by default, or the
    show initiator).
13. **Muflis** reverses hand strength; explicit suit tie rules stay unchanged
    unless `muflisTiePolicy = REVERSE_SUIT`.
14. **Bet cap** (`maxBetsPerRound`, default 24) is a safety valve against endless
    blind-chaal loops: at the cap all remaining hands are opened and the best
    hand takes the pot. Set it to `0` to play without a cap.
15. **Solo play** needs bots because a round requires two ready players; see the
    demo script.

### Remaining rule questions (kept configurable)

- Whether `235` should also beat `AAA`, and where the whole mandatory chain sits
  relative to the trails. Currently `AAA > KKK > … > 222 > 235 > AKQ …`; add
  overrides to change it — the editor validates and rejects contradictions.
- Whether a round-boot room should charge the boot per turn instead of per round
  (both supported).
- A **full show** is immediate once only two players remain; a **side show** needs
  the invited player to accept (declining resumes betting).

### Known limitations

1. Guest identity only (no passwords); tokens live in `localStorage`.
2. Shows compare exactly two players; a multi-player "open show" exists only via
   the bet cap.
3. In the assumed-card modes you must press **See cards** before choosing the
   assumed card, so those modes cannot be played fully blind.
4. No payments/deposits/withdrawals by design.

---

## 9. Acceptance tests

`npm test` runs 40 tests. Mapping to the brief:

| Required behaviour | Where |
| --- | --- |
| `222 > 235 > AKQ > AKJ > A109 > KQJ` in Normal mode | `tests/ranking.test.ts` |
| The same ordering reverses in Muflis | `tests/ranking.test.ts` |
| Card input order does not change a result | `tests/ranking.test.ts` |
| Circular constraints cannot be saved | `tests/ranking.test.ts`, `tests/game.test.ts` |
| A ranking edit cannot change a round in progress | `tests/game.test.ts` |
| Boot charged exactly once | `tests/game.test.ts` |
| Boot never below the room minimum | `tests/game.test.ts` |
| Illegal assumed card rejected | `tests/ranking.test.ts`, `tests/game.test.ts` |
| Assumed cards locked after the reveal begins | `tests/game.test.ts` |
| Virtual cards never get a suit advantage | `tests/ranking.test.ts` |
| AA / Ace-of-Spades and show-initiator rules | `tests/ranking.test.ts` |
| A shared spade gives no exclusive advantage | `tests/ranking.test.ts` |
| Unapproved Muflis does not change the game | `tests/game.test.ts` |
| Muflis cannot be requested after the reveal | `tests/game.test.ts` |
| Conflicts block settlement until resolved | `tests/game.test.ts` |
| Reconnection keeps cards, turn state and balances | `tests/game.test.ts` |
| Retried requests cannot settle twice | `tests/game.test.ts` |
| Chip totals consistent (betting, settlement, split, refund) | `tests/game.test.ts` |
| Blind vs seen stakes and counter multiplier | `tests/game.test.ts` |
| Hidden opponent cards are never leaked | `tests/game.test.ts` |
