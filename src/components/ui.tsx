import type { ReactNode } from 'react';

export function Drawer(props: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  return (
    <>
      <div className="drawer-mask" onClick={props.onClose} />
      <div className="drawer">
        <div className="drawer-head">
          <strong>{props.title}</strong>
          <button className="small" onClick={props.onClose}>关闭 ✕</button>
        </div>
        <div className="drawer-body">{props.children}</div>
      </div>
    </>
  );
}

export function Badge(props: { className?: string; children: ReactNode }) {
  return <span className={`badge ${props.className ?? 'neutral'}`}>{props.children}</span>;
}

export function KeyVal(props: { k: string; children: ReactNode }) {
  return (
    <div className="field">
      <div className="k">{props.k}</div>
      <div>{props.children}</div>
    </div>
  );
}

export function Empty(props: { text: string }) {
  return <div className="muted" style={{ padding: '24px 0', textAlign: 'center' }}>{props.text}</div>;
}
