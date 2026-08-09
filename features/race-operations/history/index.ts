// RD-RACEOPS-01 · History — slice surface.
//
// Sprint 1 ships the page shell only. The timeline (import history, publish logs,
// rollback information) is Sprint 8 and will read a `raceOperationsHistory`
// collection that does not exist yet — so this slice has no data layer today.

export { HistoryPanel } from './HistoryPanel'
