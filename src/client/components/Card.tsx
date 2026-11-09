import type { CardView } from '../../shared/views';

const SUIT_SYMBOL: Record<string, string> = { S: '\u2660', H: '\u2665', D: '\u2666', C: '\u2663' };

export function rankText(rank: number): string {
  if (rank === 14) return 'A';
  if (rank === 13) return 'K';
  if (rank === 12) return 'Q';
  if (rank === 11) return 'J';
  return String(rank);
}

export function PlayingCard({
  card,
  small,
  highlight,
}: {
  card: CardView;
  small?: boolean;
  highlight?: boolean;
}) {
  if (card.hidden) {
    return <div className={`card card--back ${small ? 'card--small' : ''}`} aria-label="face down card" />;
  }
  const red = card.suit === 'H' || card.suit === 'D';
  return (
    <div
      className={`card ${red ? 'card--red' : 'card--black'} ${card.virtual ? 'card--virtual' : ''} ${small ? 'card--small' : ''} ${
        highlight ? 'card--highlight' : ''
      }`}
      title={card.virtual ? 'Assumed (virtual) card - no suit' : undefined}
    >
      <span className="card__rank">{rankText(card.rank)}</span>
      <span className="card__suit">{card.suit ? SUIT_SYMBOL[card.suit] : '\u2731'}</span>
      {card.virtual && !small && <span className="card__virtual-tag">assumed</span>}
    </div>
  );
}

export function Hand({ cards, small }: { cards: CardView[]; small?: boolean }) {
  return (
    <div className="hand">
      {cards.map((card, i) => (
        <PlayingCard key={i} card={card} small={small} />
      ))}
    </div>
  );
}
