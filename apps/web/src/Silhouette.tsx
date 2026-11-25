/**
 * A plain silhouette for a suspect's dossier: generic shapes in front of a height chart. The
 * shapes differ only in hair and clothing outline, so the four cards are easy to tell apart.
 * They are not likenesses, and they carry no clue.
 */
export function Silhouette({ id, size = 'md' }: { id: string; size?: 'sm' | 'md' }) {
  return (
    <svg
      className={`silhouette ${size}`}
      viewBox="0 0 120 140"
      preserveAspectRatio="xMidYMax slice"
      aria-hidden="true"
      focusable="false"
    >
      <rect width="120" height="140" className="sil-bg" />
      {[20, 40, 60, 80, 100, 120].map((y) => (
        <line key={y} x1="0" x2="120" y1={y} y2={y} className="sil-rule" />
      ))}
      <Figure id={id} />
    </svg>
  );
}

function Figure({ id }: { id: string }) {
  switch (id) {
    case 'lionel':
      return (
        <g className="sil-fig">
          <path d="M18 140 C22 108 38 98 60 98 C82 98 98 108 102 140 Z" />
          <rect x="52" y="78" width="16" height="24" rx="4" />
          <ellipse cx="60" cy="58" rx="19" ry="24" />
          <g className="sil-detail">
            <path className="bow" d="M51 99 L60 103.5 L51 108 Z M69 99 L60 103.5 L69 108 Z" />
            <circle className="lens" cx="52" cy="58" r="5.5" />
            <circle className="lens" cx="68" cy="58" r="5.5" />
            <line x1="57.5" y1="58" x2="62.5" y2="58" />
          </g>
        </g>
      );
    case 'dougal':
      return (
        <g className="sil-fig">
          <path d="M4 140 C8 104 30 94 60 94 C90 94 112 104 116 140 Z" />
          <rect x="50" y="76" width="20" height="24" rx="5" />
          <ellipse cx="60" cy="56" rx="22" ry="25" />
          <path d="M38 50 C38 30 82 30 82 50 C76 40 46 40 38 50 Z" />
          <g className="sil-detail">
            <path d="M48 100 L60 118 L72 100" fill="none" />
          </g>
        </g>
      );
    case 'tessa':
      return (
        <g className="sil-fig">
          <path d="M36 60 C34 28 86 28 84 60 L88 96 C80 100 72 96 70 88 L50 88 C48 96 40 100 32 96 Z" />
          <path d="M14 140 C18 108 36 100 60 100 C84 100 102 108 106 140 Z" />
          <rect x="53" y="78" width="14" height="24" rx="4" />
          <ellipse cx="60" cy="58" rx="17" ry="22" />
          <path d="M43 52 C44 36 76 34 78 50 C68 44 54 44 43 52 Z" />
        </g>
      );
    case 'aroha':
      return (
        <g className="sil-fig">
          <circle cx="60" cy="30" r="10" />
          <path d="M14 140 C18 106 36 98 60 98 C84 98 102 106 106 140 Z" />
          <rect x="52" y="78" width="16" height="24" rx="4" />
          <ellipse cx="60" cy="58" rx="18" ry="23" />
          <path d="M42 54 C40 36 80 36 78 54 C72 42 48 42 42 54 Z" />
          <g className="sil-detail">
            <circle cx="50" cy="114" r="2.2" />
            <circle cx="50" cy="128" r="2.2" />
            <circle cx="70" cy="114" r="2.2" />
            <circle cx="70" cy="128" r="2.2" />
          </g>
        </g>
      );
    default:
      return (
        <g className="sil-fig">
          <path d="M14 140 C18 106 36 98 60 98 C84 98 102 106 106 140 Z" />
          <rect x="52" y="78" width="16" height="24" rx="4" />
          <ellipse cx="60" cy="58" rx="19" ry="24" />
        </g>
      );
  }
}
