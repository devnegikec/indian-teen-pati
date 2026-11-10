import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../src/server/db';
import { GameService } from '../src/server/game';
import { DEFAULT_RULES, type RoomRules, type RoomView } from '../src/shared/views';
import { defaultProfile } from '../src/rules/profiles';

interface Ctx {
  db: DB;
  game: GameService;
  roomId: string;
  admin: { userId: string; token: string };
  bob: { userId: string; token: string };
  cara: { userId: string; token: string };
}

function setup(rules: Partial<RoomRules> = {}, players = 3): Ctx {
  const db = openDatabase(':memory:');
  const game = new GameService(db, () => {});
  const admin = game.createGuest('Admin');
  const bob = game.createGuest('Bob');
  const cara = game.createGuest('Cara');
  const room = game.createRoom(admin.userId, 'Test room', { ...DEFAULT_RULES, startingChips: 1000, boot: 10, minBoot: 5, ...rules });
  game.handleAction(room.id, bob.userId, 'JOIN', {});
  if (players >= 3) game.handleAction(room.id, cara.userId, 'JOIN', {});
  for (const u of [admin, bob, players >= 3 ? cara : bob].slice(0, players)) {
    game.handleAction(room.id, u.userId, 'READY', { ready: true });
  }
  return { db, game, roomId: room.id, admin, bob, cara };
}

function view(ctx: Ctx, who: { userId: string }): RoomView {
  return ctx.game.roomView(ctx.roomId, who.userId);
}

function totalChips(ctx: Ctx): number {
  const rows = ctx.db.prepare('SELECT chips FROM room_members WHERE room_id = ?').all(ctx.roomId) as Array<{ chips: number }>;
  return rows.reduce((sum, r) => sum + r.chips, 0);
}

function pot(ctx: Ctx, who: { userId: string }): number {
  return view(ctx, who).round?.pot ?? 0;
}

describe('round start, boot and chip integrity', () => {
  it('charges the boot exactly once per player and keeps chips + pot constant', () => {
    const ctx = setup();
    const before = totalChips(ctx);
    ctx.game.handleAction(ctx.roomId, ctx.admin.userId, 'START_ROUND', {}, 'start-1');
    const v = view(ctx, ctx.admin);
    expect(v.round?.pot).toBe(30); // 3 players x 10
    expect(v.players.every((p) => p.chips === 990)).toBe(true);
    expect(totalChips(ctx) + (v.round?.pot ?? 0)).toBe(before);

    // replaying the same request must not charge again
    ctx.game.handleAction(ctx.roomId, ctx.admin.userId, 'START_ROUND', {}, 'start-1');
    expect(view(ctx, ctx.admin).round?.pot).toBe(30);
  });

  it('never allows the round boot to fall below the room minimum', () => {
    const ctx = setup({ minBoot: 50, boot: 10 });
    const v = view(ctx, ctx.admin);
    expect(v.room.rules.boot).toBeGreaterThanOrEqual(50);
    expect(v.room.rules.minBoot).toBe(50);
  });

  it('refuses to start without enough ready players with chips', () => {
    const db = openDatabase(':memory:');
    const game = new GameService(db, () => {});
    const solo = game.createGuest('Solo');
    const room = game.createRoom(solo.userId, 'Solo', { ...DEFAULT_RULES, startingChips: 100 });
    game.handleAction(room.id, solo.userId, 'READY', { ready: true });
    expect(() => game.handleAction(room.id, solo.userId, 'START_ROUND', {})).toThrow(/two ready players/i);
  });

  it('settles the pot to the last player standing and keeps totals consistent', () => {
    const ctx = setup();
    const before = totalChips(ctx);
    ctx.game.handleAction(ctx.roomId, ctx.admin.userId, 'START_ROUND', {});
    // seat 1 starts; fold both non-dealer seats
    ctx.game.handleAction(ctx.roomId, ctx.bob.userId, 'FOLD', {});
    ctx.game.handleAction(ctx.roomId, ctx.cara.userId, 'FOLD', {});
    let v = view(ctx, ctx.admin);
    // the winner first decides whether to show
    expect(v.round?.state).toBe('WINNER_CHOICE');
    expect(v.round?.survivorUserId).toBe(ctx.admin.userId);
    expect(v.round?.result).toBeNull();
    // nobody else sees the winner's cards yet
    expect(view(ctx, ctx.bob).players.find((p) => p.userId === ctx.admin.userId)!.cards.every((c) => c.hidden)).toBe(
      true,
    );
    ctx.game.handleAction(ctx.roomId, ctx.admin.userId, 'WINNER_ACTION', { show: false });
    v = view(ctx, ctx.admin);
    expect(v.round?.state).toBe('PROVISIONAL');
    expect(v.round?.result?.winnerUserId).toBe(ctx.admin.userId);
    expect(v.round?.result?.hands.length).toBe(0); // took the pot without showing
    ctx.game.settleRound(ctx.roomId, true);
    const settled = view(ctx, ctx.admin);
    expect(settled.round?.state).toBe('SETTLED');
    expect(totalChips(ctx)).toBe(before);
    const adminChips = settled.players.find((p) => p.userId === ctx.admin.userId)!.chips;
    expect(adminChips).toBe(1020); // 1000 - 10 boot + 30 pot
  });

  it('lets the last player show their cards before taking the pot', () => {
    const ctx = setup();
    ctx.game.handleAction(ctx.roomId, ctx.admin.userId, 'START_ROUND', {});
    ctx.game.handleAction(ctx.roomId, ctx.bob.userId, 'FOLD', {});
    ctx.game.handleAction(ctx.roomId, ctx.cara.userId, 'FOLD', {});
    ctx.game.handleAction(ctx.roomId, ctx.admin.userId, 'WINNER_ACTION', { show: true });
    const v = view(ctx, ctx.admin);
    expect(v.round?.result?.hands.length).toBe(1);
    expect(v.round?.result?.hands[0].cards.length).toBe(3);
    expect(v.round?.result?.reason).toMatch(/showed their cards/i);
    // only the winner may answer
    expect(() => ctx.game.handleAction(ctx.roomId, ctx.bob.userId, 'WINNER_ACTION', { show: false })).toThrow();
  });

  it('cannot settle twice', () => {
    const ctx = setup();
    ctx.game.handleAction(ctx.roomId, ctx.admin.userId, 'START_ROUND', {});
    ctx.game.handleAction(ctx.roomId, ctx.bob.userId, 'FOLD', {});
    ctx.game.handleAction(ctx.roomId, ctx.cara.userId, 'FOLD', {});
    ctx.game.handleAction(ctx.roomId, ctx.admin.userId, 'WINNER_ACTION', { show: false });
    ctx.game.settleRound(ctx.roomId, true);
    const afterFirst = totalChips(ctx);
    ctx.game.settleRound(ctx.roomId, true);
    expect(totalChips(ctx)).toBe(afterFirst);
  });
});

describe('betting rules', () => {
  it('blind passes, seen doubles, and after a counter the next bet is exactly three times it', () => {
    const ctx = setup({ seenMultiple: 2, counterMultiplier: 3 }); // boot 10
    ctx.game.handleAction(ctx.roomId, ctx.admin.userId, 'START_ROUND', {});
    const v1 = view(ctx, ctx.bob);
    expect(v1.round?.stake).toBe(10);
    expect(v1.round?.seenStake).toBe(20);

    // bet 1..2: blind passes at 10
    expect(v1.players.find((p) => p.userId === ctx.bob.userId)!.legal?.chaal.kind).toBe('BLIND');
    expect(v1.players.find((p) => p.userId === ctx.bob.userId)!.legal?.chaal.amount).toBe(10);
    ctx.game.handleAction(ctx.roomId, ctx.bob.userId, 'CHAAL', {});
    expect(view(ctx, ctx.cara).players.find((p) => p.userId === ctx.cara.userId)!.legal?.chaal.amount).toBe(10);
    ctx.game.handleAction(ctx.roomId, ctx.cara.userId, 'CHAAL', {});

    // bet 3: seen -> double (20)
    ctx.game.handleAction(ctx.roomId, ctx.admin.userId, 'SEE_CARDS', {});
    const adminLegal = view(ctx, ctx.admin).players.find((p) => p.userId === ctx.admin.userId)!.legal;
    expect(adminLegal?.chaal.kind).toBe('SEEN');
    expect(adminLegal?.chaal.amount).toBe(20);
    ctx.game.handleAction(ctx.roomId, ctx.admin.userId, 'CHAAL', {});

    // bet 4: blind after a seen bet -> pays the current bet (20) and counters
    const bobAgain = view(ctx, ctx.bob).players.find((p) => p.userId === ctx.bob.userId)!.legal;
    expect(bobAgain?.chaal.kind).toBe('BLIND_COUNTER');
    expect(bobAgain?.chaal.amount).toBe(20);
    ctx.game.handleAction(ctx.roomId, ctx.bob.userId, 'CHAAL', {});

    // the seen price is exactly 3 × the counter amount (60), not 6 ×
    expect(view(ctx, ctx.admin).round?.seenStake).toBe(60);

    // ...but a blind player after a counter just passes with the same amount
    const caraBlind = view(ctx, ctx.cara).players.find((p) => p.userId === ctx.cara.userId)!.legal;
    expect(caraBlind?.chaal.kind).toBe('BLIND');
    expect(caraBlind?.chaal.amount).toBe(20);

    // bet 5: a SEEN player now pays 60 (previously this wrongly paid 120)
    ctx.game.handleAction(ctx.roomId, ctx.cara.userId, 'SEE_CARDS', {});
    const caraSeen = view(ctx, ctx.cara).players.find((p) => p.userId === ctx.cara.userId)!.legal;
    expect(caraSeen?.chaal.kind).toBe('SEEN');
    expect(caraSeen?.chaal.amount).toBe(60);
    ctx.game.handleAction(ctx.roomId, ctx.cara.userId, 'CHAAL', {});
    expect(view(ctx, ctx.admin).round?.stake).toBe(60);

    // bet 6: another seen player just matches 60
    const adminAgain = view(ctx, ctx.admin).players.find((p) => p.userId === ctx.admin.userId)!.legal;
    expect(adminAgain?.chaal.amount).toBe(60);
  });

  it('requires a counter to be preceded by a bet and triples the level', () => {
    const ctx = setup({ counterMultiplier: 3 });
    ctx.game.handleAction(ctx.roomId, ctx.admin.userId, 'START_ROUND', {});
    expect(() => ctx.game.handleAction(ctx.roomId, ctx.bob.userId, 'COUNTER', {})).toThrow(/after a player has bet/i);
    ctx.game.handleAction(ctx.roomId, ctx.bob.userId, 'CHAAL', {}); // blind pass at 10
    ctx.game.handleAction(ctx.roomId, ctx.cara.userId, 'COUNTER', {}); // pays 10, seen price -> 30
    expect(view(ctx, ctx.admin).round?.seenStake).toBe(30);
  });

  it('rejects actions from players who are not on turn', () => {
    const ctx = setup();
    ctx.game.handleAction(ctx.roomId, ctx.admin.userId, 'START_ROUND', {});
    expect(() => ctx.game.handleAction(ctx.roomId, ctx.cara.userId, 'CHAAL', {})).toThrow(/not your turn/i);
  });

  it('opens all hands when the round bet cap is reached and settles consistently', () => {
    const ctx = setup({ maxBetsPerRound: 2 });
    const before = totalChips(ctx);
    ctx.game.handleAction(ctx.roomId, ctx.admin.userId, 'START_ROUND', {});
    ctx.game.handleAction(ctx.roomId, ctx.bob.userId, 'CHAAL', {});
    ctx.game.handleAction(ctx.roomId, ctx.cara.userId, 'CHAAL', {});
    const v = view(ctx, ctx.admin);
    expect(v.round?.state).toBe('PROVISIONAL');
    expect(v.round?.result?.kind).toBe('BET_CAP');
    expect(v.round?.result?.hands.length).toBe(3);
    ctx.game.settleRound(ctx.roomId, true);
    expect(view(ctx, ctx.admin).round?.state).toBe('SETTLED');
    expect(totalChips(ctx)).toBe(before);
  });
});

describe('assumed card modes', () => {
  it('rejects an illegal assumed card, requires seeing first, and accepts a legal one', () => {
    const ctx = setup({ dealingMode: 'TWO_CARD_ASSUMED' }, 2);
    ctx.game.handleAction(ctx.roomId, ctx.admin.userId, 'START_ROUND', {});
    // a blind player cannot choose an assumed card for a hand they have not seen
    expect(() => ctx.game.handleAction(ctx.roomId, ctx.bob.userId, 'SET_ASSUMED', { rank: 2 })).toThrow(/see cards/i);
    ctx.game.handleAction(ctx.roomId, ctx.bob.userId, 'SEE_CARDS', {});
    const me = view(ctx, ctx.bob).players.find((p) => p.userId === ctx.bob.userId)!;
    const top = Math.max(...me.cards.map((c) => c.rank));
    expect(() => ctx.game.handleAction(ctx.roomId, ctx.bob.userId, 'SET_ASSUMED', { rank: top + 1 })).toThrow(/assumed rank/i);
    ctx.game.handleAction(ctx.roomId, ctx.bob.userId, 'SET_ASSUMED', { rank: top });
    expect(view(ctx, ctx.bob).players.find((p) => p.userId === ctx.bob.userId)!.assumedRank).toBe(top);
  });

  it('locks the assumed card once the reveal begins', () => {
    const ctx = setup({ dealingMode: 'TWO_CARD_ASSUMED' }, 2);
    ctx.game.handleAction(ctx.roomId, ctx.admin.userId, 'START_ROUND', {});
    ctx.game.handleAction(ctx.roomId, ctx.bob.userId, 'SEE_CARDS', {});
    const bob = view(ctx, ctx.bob);
    const topBob = Math.max(...bob.players.find((p) => p.userId === ctx.bob.userId)!.cards.map((c) => c.rank));
    ctx.game.handleAction(ctx.roomId, ctx.bob.userId, 'SET_ASSUMED', { rank: topBob });
    // two active players -> show allowed
    ctx.game.handleAction(ctx.roomId, ctx.bob.userId, 'SHOW', { targetUserId: ctx.admin.userId });
    expect(view(ctx, ctx.bob).round?.state).toBe('PROVISIONAL');
    expect(() => ctx.game.handleAction(ctx.roomId, ctx.bob.userId, 'SET_ASSUMED', { rank: 2 })).toThrow();
  });

  it('only allows a full show when two players are left and offers a side show otherwise', () => {
    const ctx = setup({ dealingMode: 'TWO_CARD_ASSUMED' }, 3);
    ctx.game.handleAction(ctx.roomId, ctx.admin.userId, 'START_ROUND', {});
    expect(() =>
      ctx.game.handleAction(ctx.roomId, ctx.bob.userId, 'SHOW', { targetUserId: ctx.cara.userId }),
    ).toThrow(/two players are left/i);
    // the side show goes to the player who made the last bet
    ctx.game.handleAction(ctx.roomId, ctx.bob.userId, 'CHAAL', {}); // bob (first to act) bets
    const target = view(ctx, ctx.cara).round?.lastBettorUserId;
    expect(target).toBe(ctx.bob.userId);
    ctx.game.handleAction(ctx.roomId, ctx.cara.userId, 'SIDE_SHOW', {});
    expect(view(ctx, ctx.admin).round?.state).toBe('SIDE_SHOW_PENDING');
    expect(view(ctx, ctx.admin).round?.sideShow?.targetUserId).toBe(ctx.bob.userId);
    expect(() => ctx.game.handleAction(ctx.roomId, ctx.admin.userId, 'CHAAL', {})).toThrow();
    // nothing is revealed until the request is accepted
    const pending = view(ctx, ctx.bob);
    expect(pending.players.find((p) => p.userId === ctx.cara.userId)!.cards.every((c) => c.hidden)).toBe(true);
    expect(pending.round?.sideShow?.result).toBeNull();
    // only the invited player may answer
    expect(() => ctx.game.handleAction(ctx.roomId, ctx.admin.userId, 'RESPOND_SIDE_SHOW', { accept: true })).toThrow(
      /invited/i,
    );
    ctx.game.handleAction(ctx.roomId, ctx.bob.userId, 'RESPOND_SIDE_SHOW', { accept: true });
    const v = view(ctx, ctx.admin);
    expect(v.round?.state).toBe('BETTING');
    expect(v.round?.sideShow?.status).toBe('ACCEPTED');
    // exactly one of the two participants folded
    const folded = v.players.filter((p) => p.folded).map((p) => p.userId);
    expect(folded.length).toBe(1);
    expect([ctx.bob.userId, ctx.cara.userId]).toContain(folded[0]);
    // a side show means both players have effectively seen their cards
    expect(v.players.find((p) => p.userId === ctx.bob.userId)!.blind).toBe(false);
    expect(v.players.find((p) => p.userId === ctx.cara.userId)!.blind).toBe(false);
    // the two participants can see each other's cards, the third player cannot
    const bobView = view(ctx, ctx.bob);
    const caraCards = bobView.players.find((p) => p.userId === ctx.cara.userId)!.cards;
    expect(caraCards.every((c) => c.hidden)).toBe(false);
    expect(bobView.round?.sideShow?.result).not.toBeNull();
    expect(bobView.round?.sideShow?.result?.hands.length).toBe(2);

    const adminView = view(ctx, ctx.admin);
    expect(adminView.players.find((p) => p.userId === ctx.cara.userId)!.cards.every((c) => c.hidden)).toBe(true);
    expect(adminView.players.find((p) => p.userId === ctx.bob.userId)!.cards.every((c) => c.hidden)).toBe(true);
    // outsiders only get a plain announcement: no hands, no hand classes
    expect(adminView.round?.sideShow?.result).toBeNull();
    expect(adminView.round?.sideShow?.announcement).toMatch(/side show/i);
    expect(adminView.round?.sideShow?.announcement).not.toMatch(/high card|trail|colour|pair|sequence/i);
    expect(adminView.round?.log.some((l) => /high card|trail|colour|pair|sequence/i.test(l.text))).toBe(false);
  });

  it('resumes betting when a side show is declined', () => {
    const ctx = setup();
    ctx.game.handleAction(ctx.roomId, ctx.admin.userId, 'START_ROUND', {});
    // the side show is offered to the player who made the last bet
    ctx.game.handleAction(ctx.roomId, ctx.bob.userId, 'CHAAL', {});
    ctx.game.handleAction(ctx.roomId, ctx.cara.userId, 'SIDE_SHOW', {});
    ctx.game.handleAction(ctx.roomId, ctx.bob.userId, 'RESPOND_SIDE_SHOW', { accept: false });
    const v = view(ctx, ctx.admin);
    expect(v.round?.state).toBe('BETTING');
    expect(v.round?.sideShow?.status).toBe('DECLINED');
    expect(v.players.some((p) => p.folded)).toBe(false);
  });
});

describe('Muflis policy', () => {
  it('does not change the game when the request is not approved', () => {
    const ctx = setup();
    ctx.game.handleAction(ctx.roomId, ctx.admin.userId, 'START_ROUND', {});
    ctx.game.handleAction(ctx.roomId, ctx.bob.userId, 'REQUEST_MUFLIS', {});
    let v = view(ctx, ctx.admin);
    expect(v.round?.state).toBe('MUFLIS_PENDING');
    expect(v.round?.muflis).toBe(false);
    // betting is paused
    expect(() => ctx.game.handleAction(ctx.roomId, ctx.cara.userId, 'CHAAL', {})).toThrow();
    ctx.game.handleAction(ctx.roomId, ctx.admin.userId, 'VOTE_MUFLIS', { approve: false });
    v = view(ctx, ctx.admin);
    expect(v.round?.muflis).toBe(false);
    expect(v.round?.state).toBe('BETTING');
  });

  it('switches the round to Muflis on approval and keeps the pot', () => {
    const ctx = setup();
    ctx.game.handleAction(ctx.roomId, ctx.admin.userId, 'START_ROUND', {});
    ctx.game.handleAction(ctx.roomId, ctx.bob.userId, 'CHAAL', {});
    const potBefore = view(ctx, ctx.admin).round!.pot;
    ctx.game.handleAction(ctx.roomId, ctx.cara.userId, 'REQUEST_MUFLIS', {});
    ctx.game.handleAction(ctx.roomId, ctx.admin.userId, 'VOTE_MUFLIS', { approve: true });
    const v = view(ctx, ctx.admin);
    expect(v.round?.muflis).toBe(true);
    expect(v.round?.pot).toBe(potBefore);
    expect(v.round?.log.some((l) => /Muflis APPROVED/i.test(l.text))).toBe(true);
  });

  it('supports unanimous approval by all active players', () => {
    const ctx = setup({ muflisApproval: 'UNANIMOUS' });
    ctx.game.handleAction(ctx.roomId, ctx.admin.userId, 'START_ROUND', {});
    ctx.game.handleAction(ctx.roomId, ctx.bob.userId, 'REQUEST_MUFLIS', {});
    // one approval is not enough
    ctx.game.handleAction(ctx.roomId, ctx.cara.userId, 'VOTE_MUFLIS', { approve: true });
    expect(view(ctx, ctx.admin).round?.muflis).toBe(false);
    expect(view(ctx, ctx.admin).round?.state).toBe('MUFLIS_PENDING');
    ctx.game.handleAction(ctx.roomId, ctx.admin.userId, 'VOTE_MUFLIS', { approve: true });
    expect(view(ctx, ctx.admin).round?.muflis).toBe(true);
  });

  it('rejects a Muflis request once cards are revealed', () => {
    const ctx = setup({ dealingMode: 'TWO_CARD_ASSUMED' }, 2);
    ctx.game.handleAction(ctx.roomId, ctx.admin.userId, 'START_ROUND', {});
    ctx.game.handleAction(ctx.roomId, ctx.bob.userId, 'SHOW', { targetUserId: ctx.admin.userId });
    expect(() => ctx.game.handleAction(ctx.roomId, ctx.bob.userId, 'REQUEST_MUFLIS', {})).toThrow();
  });
});

describe('disputes', () => {
  it('splits the pot on an administrator split decision and keeps totals consistent', () => {
    const ctx = setup();
    const before = totalChips(ctx);
    ctx.game.handleAction(ctx.roomId, ctx.admin.userId, 'START_ROUND', {});
    ctx.game.handleAction(ctx.roomId, ctx.bob.userId, 'CHAAL', {});
    ctx.game.handleAction(ctx.roomId, ctx.cara.userId, 'RAISE_CONFLICT', { reason: 'Suspected dealing bug' });
    const potBefore = view(ctx, ctx.admin).round!.pot;
    ctx.game.handleAction(ctx.roomId, ctx.admin.userId, 'RESOLVE_CONFLICT', {
      decision: 'SPLIT',
      explanation: 'Splitting the pot between the three active players.',
    });
    const v = view(ctx, ctx.admin);
    expect(v.round?.result?.kind).toBe('ADMIN_SPLIT');
    expect(v.round?.state).toBe('SETTLED');
    expect(totalChips(ctx)).toBe(before);
    const amounts = Object.values(v.round?.result?.amounts ?? {});
    expect(amounts.reduce((a, b) => a + b, 0)).toBe(potBefore);
  });
  it('freezes settlement until the administrator resolves it and refunds on void', () => {
    const ctx = setup();
    const before = totalChips(ctx);
    ctx.game.handleAction(ctx.roomId, ctx.admin.userId, 'START_ROUND', {});
    ctx.game.handleAction(ctx.roomId, ctx.bob.userId, 'FOLD', {});
    ctx.game.handleAction(ctx.roomId, ctx.cara.userId, 'FOLD', {});
    ctx.game.handleAction(ctx.roomId, ctx.bob.userId, 'RAISE_CONFLICT', { reason: 'I think the cards were wrong' });
    expect(view(ctx, ctx.admin).round?.state).toBe('DISPUTE');
    expect(() => ctx.game.settleRound(ctx.roomId, true)).toThrow(/dispute/i);
    expect(() =>
      ctx.game.handleAction(ctx.roomId, ctx.admin.userId, 'RESOLVE_CONFLICT', { decision: 'VOID' }),
    ).toThrow(/explanation/i);
    ctx.game.handleAction(ctx.roomId, ctx.admin.userId, 'RESOLVE_CONFLICT', {
      decision: 'VOID',
      explanation: 'Dealing error, refunding everyone.',
    });
    const v = view(ctx, ctx.admin);
    expect(v.round?.state).toBe('SETTLED');
    expect(v.round?.result?.kind).toBe('ADMIN_VOID');
    expect(totalChips(ctx)).toBe(before);
  });

  it('lets the administrator pick a winner', () => {
    const ctx = setup();
    ctx.game.handleAction(ctx.roomId, ctx.admin.userId, 'START_ROUND', {});
    ctx.game.handleAction(ctx.roomId, ctx.bob.userId, 'FOLD', {});
    ctx.game.handleAction(ctx.roomId, ctx.cara.userId, 'FOLD', {});
    ctx.game.handleAction(ctx.roomId, ctx.cara.userId, 'RAISE_CONFLICT', { reason: 'Please review' });
    ctx.game.handleAction(ctx.roomId, ctx.admin.userId, 'RESOLVE_CONFLICT', {
      decision: 'WINNER',
      winnerUserId: ctx.cara.userId,
      explanation: 'Cara had the best hand.',
    });
    expect(view(ctx, ctx.admin).round?.result?.winnerUserId).toBe(ctx.cara.userId);
    expect(view(ctx, ctx.admin).round?.state).toBe('SETTLED');
  });
});

describe('ranking profiles and rounds', () => {
  it('refuses to save a profile with circular rules', () => {
    const db = openDatabase(':memory:');
    const game = new GameService(db, () => {});
    const base = defaultProfile();
    expect(() =>
      game.saveProfile({
        ...base,
        id: 'cyclic',
        overrides: [
          { stronger: '14-13-12', weaker: '14-13-11' },
          { stronger: '14-13-11', weaker: '14-10-9' },
          { stronger: '14-10-9', weaker: '14-13-12' },
        ],
      }),
    ).toThrow(/contradict|loop/i);
  });

  it('freezes the ranking profile version for the running round', () => {
    const ctx = setup();
    ctx.game.handleAction(ctx.roomId, ctx.admin.userId, 'START_ROUND', {});
    const versionBefore = view(ctx, ctx.admin).round!.ranking.version;
    const profile = ctx.game.getProfile(view(ctx, ctx.admin).room.rankingProfileId)!;
    ctx.game.saveProfile({ ...profile, overrides: [...profile.overrides, { stronger: '13-13-13', weaker: '14-13-12' }] });
    const versionAfter = view(ctx, ctx.admin).round!.ranking.version;
    expect(versionAfter).toBe(versionBefore);
    expect(ctx.game.getProfile(profile.id)!.version).toBeGreaterThan(profile.version);
  });
});

describe('reconnection', () => {
  it('keeps seat, cards, turn and balances after a disconnect', () => {
    const ctx = setup();
    ctx.game.handleAction(ctx.roomId, ctx.admin.userId, 'START_ROUND', {});
    const before = view(ctx, ctx.bob);
    ctx.game.setConnected(ctx.roomId, ctx.bob.userId, false);
    const offline = view(ctx, ctx.bob);
    expect(offline.players.find((p) => p.userId === ctx.bob.userId)!.connected).toBe(false);
    ctx.game.setConnected(ctx.roomId, ctx.bob.userId, true);
    const after = view(ctx, ctx.bob);
    expect(after.players.find((p) => p.userId === ctx.bob.userId)!.seat).toBe(before.players.find((p) => p.userId === ctx.bob.userId)!.seat);
    expect(after.players.find((p) => p.userId === ctx.bob.userId)!.cards).toEqual(
      before.players.find((p) => p.userId === ctx.bob.userId)!.cards,
    );
    expect(after.round?.turnSeat).toBe(before.round?.turnSeat);
    expect(after.players.find((p) => p.userId === ctx.bob.userId)!.chips).toBe(
      before.players.find((p) => p.userId === ctx.bob.userId)!.chips,
    );
  });

  it('keeps your own cards hidden until you press See cards', () => {
    const ctx = setup();
    ctx.game.handleAction(ctx.roomId, ctx.admin.userId, 'START_ROUND', {});
    const before = view(ctx, ctx.bob);
    const ownBefore = before.players.find((p) => p.userId === ctx.bob.userId)!;
    expect(ownBefore.blind).toBe(true);
    expect(ownBefore.cards.length).toBe(3);
    expect(ownBefore.cards.every((c) => c.hidden)).toBe(true);
    expect(ownBefore.handLabel).toBeNull();
    // opponents stay hidden too
    expect(before.players.find((p) => p.userId === ctx.admin.userId)!.cards.every((c) => c.hidden)).toBe(true);

    ctx.game.handleAction(ctx.roomId, ctx.bob.userId, 'SEE_CARDS', {});
    const after = view(ctx, ctx.bob);
    const ownAfter = after.players.find((p) => p.userId === ctx.bob.userId)!;
    expect(ownAfter.blind).toBe(false);
    expect(ownAfter.cards.some((c) => !c.hidden && c.rank > 0)).toBe(true);
    expect(ownAfter.handLabel).not.toBeNull();
  });
});

describe('dealing modes', () => {
  it('deals one private card plus one shared open card', () => {
    const ctx = setup({ dealingMode: 'ONE_CARD_SHARED' });
    ctx.game.handleAction(ctx.roomId, ctx.admin.userId, 'START_ROUND', {});
    const v = view(ctx, ctx.admin);
    expect(v.round?.sharedCard).not.toBeNull();
    expect(v.players.every((p) => p.cards.length === 1)).toBe(true);
  });
});

describe('default profile', () => {
  it('is seeded and resolvable', () => {
    const db = openDatabase(':memory:');
    const game = new GameService(db, () => {});
    const profiles = game.listProfiles();
    expect(profiles.some((p) => p.id === defaultProfile().id)).toBe(true);
  });
});
