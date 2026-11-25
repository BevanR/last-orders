import { useState } from 'react';

export function inviteLink(code: string) {
  return `${window.location.origin}/r/${code}`;
}

export function CopyLink({ label, url }: { label: string; url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy">
      <span className="muted small">{label}</span>
      <div className="copy-row">
        <input readOnly aria-label={label} value={url} onFocus={(e) => e.currentTarget.select()} />
        <button
          onClick={() =>
            navigator.clipboard?.writeText(url).then(
              () => setCopied(true),
              () => {},
            )
          }
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}
