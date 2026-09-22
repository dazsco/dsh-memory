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
.dshMemBody { margin: 0 16px; padding: 12px 0 8px; }
.dshMemReadOnly { color: var(--dsw-alias-label-tertiary); margin: 0 0 12px; font-size: 12px; line-height: 1.5; }
.dshMemUnavailable { color: var(--dsw-alias-label-tertiary); margin: 0; font-size: 13px; line-height: 1.5; }
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

/* ── Memory page (browse + per-card management section) ───────────────── */
.dshMemPage { flex-direction: column; gap: 12px; padding: 4px 2px; display: flex; }
.dshMemPageHead { align-items: flex-start; gap: 12px; display: flex; justify-content: space-between; }
.dshMemPageHeadText { flex-direction: column; gap: 2px; min-width: 0; display: flex; }
.dshMemPageTitle { color: var(--dsw-alias-label-primary); margin: 0; font-size: 16px; font-weight: 600; line-height: 1.4; }
.dshMemPageSub { color: var(--dsw-alias-label-tertiary); margin: 0; font-size: 12px; line-height: 1.5; }
.dshMemPageActions { align-items: center; flex: none; gap: 8px; display: flex; }
.dshMemPageBtn {
  appearance: none;
  font: inherit;
  cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-primary);
  border-radius: 8px;
  padding: 5px 12px;
  font-size: 13px;
  line-height: 1.5;
}
.dshMemPageBtn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.dshMemPageBtn:disabled { opacity: .5; cursor: default; }
.dshMemPageBtn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dshMemPageBtnOk { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.dshMemPageBtnError { border-color: var(--dsw-alias-label-error); color: var(--dsw-alias-label-error); }
.dshMemPageMeta { align-items: baseline; color: var(--dsw-alias-label-tertiary); gap: 14px; margin: 0; font-size: 12px; line-height: 1.5; display: flex; flex-wrap: wrap; }
.dshMemPageOk { color: var(--dsw-alias-label-secondary); font-weight: 500; }
.dshMemPageWarn { color: var(--dsw-alias-label-error); font-weight: 500; }
.dshMemPageEmpty { color: var(--dsw-alias-label-tertiary); margin: 8px 0; font-size: 13px; line-height: 1.5; }
.dshMemPageError { color: var(--dsw-alias-label-error); margin: 0; font-size: 12px; line-height: 1.5; word-break: break-word; }
.dshMemStoreRow { flex-wrap: wrap; gap: 8px; display: flex; }
.dshMemStoreChip {
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  min-width: 150px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-primary);
  border-radius: 10px;
  padding: 8px 12px;
  font: inherit;
  cursor: pointer;
  text-align: left;
  transition: border-color .16s, background .16s;
}
.dshMemStoreChip:hover { border-color: var(--dsw-alias-label-dimmed); }
.dshMemStoreChipActive { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-module-platform); }
.dshMemStoreChip:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dshMemStoreName { min-width: 0; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 600; }
.dshMemStoreCount { color: var(--dsw-alias-label-tertiary); font-size: 11px; font-variant-numeric: tabular-nums; }
.dshMemStorePane { border-top: 1px solid var(--dsw-alias-border-l2); flex-direction: column; gap: 10px; padding-top: 10px; display: flex; }
.dshMemPaneTabs { align-items: center; gap: 4px; display: flex; }
.dshMemPaneTab {
  font: inherit;
  color: var(--dsw-alias-label-secondary);
  background: none;
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 4px 12px;
  font-size: 13px;
  cursor: pointer;
}
.dshMemPaneTab:hover { color: var(--dsw-alias-label-primary); }
.dshMemPaneTabActive { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-brand-primary); font-weight: 500; }
.dshMemPaneTab:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dshMemSearch {
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-3);
  height: 32px;
  font: inherit;
  color: var(--dsw-alias-label-primary);
  border-radius: 8px;
  padding: 0 12px;
  font-size: 13px;
  width: 100%;
  box-sizing: border-box;
}
.dshMemSearch:focus-visible { border-color: var(--dsw-alias-brand-primary); outline: none; }
.dshMemCardList { list-style: none; margin: 0; padding: 0; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; overflow: hidden; }
.dshMemCardList > li + li { border-top: 1px solid var(--dsw-alias-border-l2); }
.dshMemCardRow {
  flex-direction: column;
  gap: 2px;
  width: 100%;
  font: inherit;
  text-align: left;
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-primary);
  border: 0;
  cursor: pointer;
  padding: 10px 12px;
}
.dshMemCardRow:hover { background: var(--dsw-alias-bg-module-platform); }
.dshMemCardRowActive { background: var(--dsw-alias-bg-module-platform); box-shadow: inset 2px 0 0 var(--dsw-alias-brand-primary); }
.dshMemCardRow:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.dshMemCardRowTitle { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 500; }
.dshMemCardRowMeta { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 1.5; word-break: break-word; }
.dshMemCardDetail { border-top: 1px solid var(--dsw-alias-border-l2); padding-top: 10px; }
.dshMemDetailCard {
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-3);
  border-radius: 10px;
  padding: 12px 14px;
}
.dshMemDetailTitle { color: var(--dsw-alias-label-primary); margin: 0 0 6px; font-size: 14px; font-weight: 600; line-height: 1.45; }
.dshMemDetailBody { color: var(--dsw-alias-label-secondary); margin: 0 0 10px; font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
.dshMemDetailGrid { margin: 0; }
.dshMemDetailRow { align-items: baseline; gap: 10px; padding: 4px 0; display: flex; }
.dshMemDetailRow + .dshMemDetailRow { border-top: 1px solid var(--dsw-alias-border-l2); }
.dshMemDetailLabel { flex: none; color: var(--dsw-alias-label-tertiary); min-width: 90px; font-size: 12px; }
.dshMemDetailValue { min-width: 0; flex: 1; margin: 0; color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 1.5; word-break: break-word; }
.dshMemInboxRow { align-items: baseline; gap: 10px; padding: 8px 12px; display: flex; }
.dshMemInboxVia {
  flex: none;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-module-platform);
  padding: 0 8px;
  font-size: 11px;
  line-height: 18px;
  white-space: nowrap;
}
.dshMemInboxTs { flex: none; color: var(--dsw-alias-label-tertiary); font-size: 11px; font-variant-numeric: tabular-nums; }
.dshMemInboxContent { min-width: 0; color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 1.5; word-break: break-word; }

/* ── Memory page v2: per-card actions + archive tab ─────────────────────── */
.dshMemDetailActions { align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--dsw-alias-border-l2); display: flex; }
.dshMemPageBtnSmall { padding: 2px 10px; font-size: 12px; }
.dshMemPageBtnDanger { color: var(--dsw-alias-label-secondary); }
.dshMemPageBtnDanger:hover:not(:disabled) { border-color: var(--dsw-alias-label-error); color: var(--dsw-alias-label-error); }
.dshMemPageBtnDangerArmed { border-color: var(--dsw-alias-label-error); color: var(--dsw-alias-label-error); font-weight: 600; }
.dshMemPageBtnDangerArmed:hover:not(:disabled) { color: var(--dsw-alias-label-error); }
.dshMemActionHint { color: var(--dsw-alias-label-tertiary); margin: 0 0 0 auto; font-size: 11px; line-height: 1.5; }
.dshMemActionError { color: var(--dsw-alias-label-error); width: 100%; margin: 0; font-size: 12px; line-height: 1.5; word-break: break-word; }
.dshMemArchiveRow { align-items: center; gap: 12px; background: var(--dsw-alias-bg-layer-3); padding: 8px 12px; display: flex; }
.dshMemArchiveRow:hover { background: var(--dsw-alias-bg-module-platform); }
.dshMemArchiveText { min-width: 0; flex: 1; flex-direction: column; gap: 2px; display: flex; }
.dshMemArchiveTitle { min-width: 0; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 500; }
.dshMemArchiveMeta { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 1.5; }

/* ── Memory page v3: stats, filters, editing, audit, export/import ─────── */
.dshMemPageNote { color: var(--dsw-alias-label-secondary); margin: 0; font-size: 12px; line-height: 1.5; word-break: break-word; }
.dshMemStats {
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
  display: flex;
}
.dshMemStat {
  flex-direction: column;
  gap: 2px;
  min-width: 84px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-3);
  border-radius: 10px;
  padding: 6px 12px;
}
.dshMemStatLabel { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 1.5; }
.dshMemStatValue { color: var(--dsw-alias-label-primary); margin: 0; font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.3; }
.dshMemPaneStats { flex-wrap: wrap; gap: 16px; display: flex; }
.dshMemPaneStatBlock { flex-direction: column; gap: 4px; min-width: 0; display: flex; }
.dshMemPaneStatTitle { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 1.5; }
.dshMemChipRow { align-items: center; flex-wrap: wrap; gap: 6px; display: flex; }
.dshMemKindChip {
  align-items: baseline;
  gap: 6px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
  border-radius: 999px;
  padding: 1px 10px;
  font-size: 11px;
  line-height: 18px;
  white-space: nowrap;
  display: inline-flex;
}
.dshMemKindCount { color: var(--dsw-alias-label-primary); font-weight: 600; font-variant-numeric: tabular-nums; }
.dshMemTagChip {
  align-items: baseline;
  gap: 6px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
  border-radius: 999px;
  padding: 1px 10px;
  font: inherit;
  font-size: 11px;
  line-height: 18px;
  white-space: nowrap;
  cursor: pointer;
  display: inline-flex;
}
.dshMemTagChip:hover { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.dshMemTagChipActive { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); font-weight: 600; }
.dshMemTagChip:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dshMemTagCount { color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.dshMemFilters { align-items: center; flex-wrap: wrap; gap: 6px; display: flex; }
.dshMemFilterLabel { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 1.5; }
.dshMemFilterCount { color: var(--dsw-alias-label-tertiary); margin-left: auto; font-size: 11px; font-variant-numeric: tabular-nums; line-height: 1.5; }
.dshMemNew { flex-direction: column; gap: 8px; display: flex; }
.dshMemDraft {
  flex-direction: column;
  gap: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-3);
  border-radius: 10px;
  padding: 10px 12px;
}
.dshMemDraftRow { align-items: center; gap: 8px; display: flex; }
.dshMemDraftLabel { flex: none; color: var(--dsw-alias-label-secondary); min-width: 96px; font-size: 12px; line-height: 1.5; }
.dshMemDraftRow .dshMemInput, .dshMemDraftRow .dshMemSelect { flex: 1; min-width: 0; }
.dshMemTextArea {
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-3);
  font: inherit;
  color: var(--dsw-alias-label-primary);
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 13px;
  line-height: 1.6;
  min-height: 96px;
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
}
.dshMemTextArea:focus-visible { border-color: var(--dsw-alias-brand-primary); outline: none; }
.dshMemTextArea:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
.dshMemEdit { flex-direction: column; gap: 8px; margin-bottom: 10px; display: flex; }
.dshMemActionOk { color: var(--dsw-alias-brand-primary); width: 100%; margin: 0; font-size: 12px; line-height: 1.5; word-break: break-word; }
.dshMemFileInput { display: none; }
.dshMemAuditHead, .dshMemAuditRow {
  align-items: baseline;
  gap: 10px;
  padding: 6px 12px;
  display: flex;
}
.dshMemAuditHead {
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  font-weight: 600;
  line-height: 1.5;
}
.dshMemAuditList { list-style: none; margin: 0; padding: 0; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; overflow: hidden; }
.dshMemAuditList > li + li { border-top: 1px solid var(--dsw-alias-border-l2); }
.dshMemAuditRow { background: var(--dsw-alias-bg-layer-3); }
.dshMemAuditRow:hover { background: var(--dsw-alias-bg-module-platform); }
.dshMemAuditTime { flex: none; color: var(--dsw-alias-label-tertiary); width: 150px; font-size: 11px; font-variant-numeric: tabular-nums; }
.dshMemAuditOp { flex: none; color: var(--dsw-alias-label-primary); width: 84px; font-size: 12px; font-weight: 500; }
.dshMemAuditVia {
  flex: none;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-module-platform);
  padding: 0 8px;
  font-size: 11px;
  line-height: 18px;
  white-space: nowrap;
}
.dshMemAuditId { flex: none; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 1.5; }
.dshMemAuditDetail { min-width: 0; flex: 1; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 1.5; word-break: break-word; }
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
