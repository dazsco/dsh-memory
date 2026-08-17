/**
 * Styles for the dsh-memory settings card, injected at factory materialization
 * so the client module system's style bookkeeping (HMR) owns them. Uses the
 * DSH design tokens (`--dsw-alias-*`) so the card follows the active theme.
 */

const css = `
.dshMemCard {
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-3);
  border-radius: 12px;
  list-style: none;
  transition: border-color .16s, background .16s;
}
.dshMemCard:hover { border-color: var(--dsw-alias-label-dimmed); }
.dshMemCardOpen {
  background: var(--dsw-alias-bg-layer-2);
  border-color: var(--dsw-alias-label-dimmed);
}
.dshMemHeader {
  appearance: none;
  width: 100%;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  background: none;
  border: 0;
  border-radius: 12px;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  display: flex;
}
.dshMemHeader:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.dshMemHeadText { flex-direction: column; flex: 1; gap: 4px; min-width: 0; display: flex; }
.dshMemName { color: var(--dsw-alias-label-primary); font-size: 15px; font-weight: 600; line-height: 1.4; }
.dshMemDescription { color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 1.5; }
.dshMemChevron { color: var(--dsw-alias-label-tertiary); flex: none; transition: transform .16s; }
.dshMemChevronOpen { transform: rotate(180deg); }
.dshMemBody { border-top: 1px solid var(--dsw-alias-border-l2); margin: 0 16px; padding-bottom: 8px; }
.dshMemReadOnly { color: var(--dsw-alias-label-tertiary); margin: 12px 0 0; font-size: 12px; line-height: 1.5; }
.dshMemPending {
  white-space: nowrap;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
  border-radius: 999px;
  flex: none;
  padding: 1px 8px;
  font-size: 11px;
  font-weight: 500;
  line-height: 17px;
}
.dshMemFooter {
  border-top: 1px solid var(--dsw-alias-border-l2);
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  padding: 12px 0 4px;
  display: flex;
}
.dshMemFailed { min-width: 0; color: var(--dsw-alias-label-error); flex: 1; margin: 0; font-size: 12px; line-height: 1.5; }
.dshMemDiscard, .dshMemSave {
  appearance: none;
  font: inherit;
  cursor: pointer;
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 5px 14px;
  font-size: 13px;
  line-height: 1.5;
}
.dshMemDiscard { border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); background: none; }
.dshMemDiscard:hover:not(:disabled) { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-label-dimmed); }
.dshMemSave { background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-layer-3); }
.dshMemDiscard:disabled, .dshMemSave:disabled { opacity: .4; cursor: default; }
.dshMemDiscard:focus-visible, .dshMemSave:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dshMemGroup { border-top: 1px solid var(--dsw-alias-border-l2); flex-direction: column; padding: 10px 0 0; display: flex; }
.dshMemGroupTitle { color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 600; line-height: 1.5; padding: 4px 0 2px; }
.dshMemField { flex-direction: column; gap: 6px; padding: 12px 0; display: flex; }
.dshMemField + .dshMemField { border-top: 1px solid var(--dsw-alias-border-l2); }
.dshMemHead { align-items: center; gap: 8px; display: flex; }
.dshMemLabel { min-width: 0; color: var(--dsw-alias-label-primary); flex: 1; font-size: 13px; font-weight: 500; line-height: 1.5; }
.dshMemBadges { align-items: center; gap: 8px; display: inline-flex; }
.dshMemBadge {
  white-space: nowrap;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  font-weight: 500;
  line-height: 17px;
}
.dshMemReset {
  font: inherit;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  background: none;
  border: none;
  padding: 0;
  font-size: 12px;
  line-height: 1.5;
}
.dshMemReset:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }
.dshMemReset:disabled { cursor: default; }
.dshMemInput {
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-3);
  height: 34px;
  font: inherit;
  color: var(--dsw-alias-label-primary);
  border-radius: 8px;
  padding: 0 12px;
  font-size: 13px;
  line-height: 1.5;
}
.dshMemInput:focus-visible { border-color: var(--dsw-alias-brand-primary); outline: none; }
.dshMemInput:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
.dshMemInputInvalid { border-color: var(--dsw-alias-label-error); }
.dshMemSelect {
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-3);
  height: 34px;
  font: inherit;
  color: var(--dsw-alias-label-primary);
  border-radius: 8px;
  padding: 0 8px;
  font-size: 13px;
  line-height: 1.5;
}
.dshMemSelect:focus-visible { border-color: var(--dsw-alias-brand-primary); outline: none; }
.dshMemSelect:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
.dshMemInvalid { color: var(--dsw-alias-label-error); margin: 0; font-size: 12px; line-height: 1.5; }
.dshMemHint { color: var(--dsw-alias-label-tertiary); margin: 0; font-size: 12px; line-height: 1.5; }
.dshMemDreamNow {
  appearance: none;
  font: inherit;
  cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-primary);
  border-radius: 8px;
  padding: 5px 14px;
  font-size: 13px;
  line-height: 1.5;
}
.dshMemDreamNow:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.dshMemDreamNow:disabled { opacity: .4; cursor: default; }
.dshMemDreamNow:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dshMemDreamNowOk { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.dshMemDreamNowError { border-color: var(--dsw-alias-label-error); color: var(--dsw-alias-label-error); }
.dshMemDreamSeq { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
`;

/** Inject the stylesheet once; a no-op outside a browser environment. */
export function injectStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.querySelector('style[data-plugin-css="dsh-memory/card"]') !== null) return;
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-memory';
  tag.dataset.pluginCss = 'dsh-memory/card';
  tag.textContent = css;
  document.head.appendChild(tag);
}
