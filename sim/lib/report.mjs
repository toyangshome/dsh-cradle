/**
 * Post-run report: server-side aggregates, world-side traffic, and the
 * invariants that must hold if the economy is sound.
 *
 * The checks are deliberately independent of the simulator's own bookkeeping:
 * they read the admin API, so a bug in the world cannot hide a bug in the
 * server.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Read every ledger row, paging through the admin API. */
async function fetchLedger(client) {
  const rows = []
  for (let offset = 0; offset < 50000; offset += 500) {
    const result = await client.admin(`/admin/v1/ledger?limit=500&offset=${offset}`)
    if (result.status !== 200) break
    const page = result.payload?.ledger ?? []
    rows.push(...page)
    if (page.length < 500) break
  }
  return rows
}

function gini(values) {
  const sorted = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b)
  const n = sorted.length
  if (n === 0) return 0
  const sum = sorted.reduce((a, b) => a + b, 0)
  if (sum === 0) return 0
  let cumulative = 0
  for (let i = 0; i < n; i += 1) cumulative += (i + 1) * sorted[i]
  return (2 * cumulative) / (n * sum) - (n + 1) / n
}

function histogram(events, key) {
  const out = {}
  for (const event of events) {
    const value = event[key]
    if (value === undefined) continue
    out[value] = (out[value] ?? 0) + 1
  }
  return out
}

export async function buildReport({ world, client, scenario, runDir }) {
  const [overviewRes, agentsRes, ledger, escrowsRes, attestRes] = await Promise.all([
    client.admin('/admin/v1/overview'),
    client.admin('/admin/v1/agents?limit=200'),
    fetchLedger(client),
    client.admin('/admin/v1/escrows?limit=200'),
    client.admin('/admin/v1/attestations?limit=200'),
  ])

  const overview = overviewRes.payload?.overview ?? {}
  const serverAgents = agentsRes.payload?.agents ?? []
  const escrows = escrowsRes.payload?.escrows ?? []
  const attestations = attestRes.payload?.attestations ?? []
  // The admin lists are capped, and the database may hold earlier runs, so
  // every displayed economy number is scoped to the DIDs this world created.
  const runEscrows = escrows.filter((escrow) => world.allDids.has(escrow.payer) || world.allDids.has(escrow.payee))
  const runAttestations = attestations.filter((row) => world.allDids.has(row.from) || world.allDids.has(row.to))

  const sendEvents = world.events.filter((event) => event.kind === 'send')
  const inboundEvents = world.events.filter((event) => event.kind === 'inbound')
  const faultEvents = world.events.filter((event) => event.kind === 'fault')
  const rebirthEvents = world.events.filter((event) => event.kind === 'rebirth')

  const totals = {
    sent: world.agents.reduce((sum, agent) => sum + agent.stats.sent, 0),
    received: world.agents.reduce((sum, agent) => sum + agent.stats.received, 0),
    admitted: world.agents.reduce((sum, agent) => sum + agent.stats.admitted, 0),
    rejected: world.agents.reduce((sum, agent) => sum + agent.stats.rejected, 0),
    errors: world.agents.reduce((sum, agent) => sum + agent.stats.errors, 0),
    charged: world.agents.reduce((sum, agent) => sum + agent.stats.charged, 0),
    rebirths: world.agents.reduce((sum, agent) => sum + agent.stats.rebirths, 0),
    ticks: world.tick,
  }

  const byPrimitive = histogram(sendEvents, 'primitive')
  const verdicts = histogram(inboundEvents, 'verdict')
  const gates = histogram(inboundEvents, 'gate')

  const ledgerByDid = new Map()
  for (const row of ledger) {
    ledgerByDid.set(row.did, (ledgerByDid.get(row.did) ?? 0) + row.delta)
  }
  const agentByDid = new Map(serverAgents.map((agent) => [agent.did, agent]))

  const conservationMismatches = []
  for (const did of world.allDids) {
    const agent = agentByDid.get(did)
    if (agent === undefined) continue
    const ledgerSum = ledgerByDid.get(did) ?? 0
    const expected = agent.credits - 50
    if (expected !== ledgerSum) {
      conservationMismatches.push({ did, credits: agent.credits, ledger: ledgerSum, expected })
    }
  }

  const ledgerByRef = new Map()
  for (const row of ledger) {
    if (!row.ref) continue
    if (!ledgerByRef.has(row.ref)) ledgerByRef.set(row.ref, [])
    ledgerByRef.get(row.ref).push(row)
  }
  const unpaidEscrows = runEscrows.filter((escrow) => escrow.status === 'RELEASED'
    && !(ledgerByRef.get(escrow.trace_id) ?? []).some((row) => row.delta > 0))

  const badAttestations = runAttestations.filter((row) => ![ -1, 0, 1 ].includes(row.verdict)
    || !Number.isFinite(row.weight) || Math.abs(row.weight) > 1.0001)

  const negativeCredits = serverAgents.filter((agent) => agent.credits < 0)
  const badReputation = serverAgents.filter((agent) => agent.reputation < 0.1 || agent.reputation > 10)

  const duplicateFaults = faultEvents.filter((event) => event.type === 'duplicate')
  const duplicateLeaks = duplicateFaults.filter((event) => event.duplicate !== true || event.charged !== 0)

  const faultySends = sendEvents.filter((event) => event.fault)
  const tamperedWrong = faultySends.filter((event) => event.fault === 'tampered' && event.status !== 400)
  const expiredWrong = faultySends.filter((event) => event.fault === 'expired' && event.status !== 400)

  const runAgents = serverAgents.filter((agent) => world.allDids.has(agent.did))
  const credits = runAgents.reduce((sum, agent) => sum + agent.credits, 0)

  const invariants = [
    {
      name: 'traffic',
      ok: totals.sent > 0 && totals.admitted > 0,
      detail: `${totals.sent} sent · ${totals.admitted} admitted`,
    },
    {
      name: 'credits non-negative',
      ok: negativeCredits.length === 0,
      detail: negativeCredits.length === 0 ? 'all agents ≥ 0' : `${negativeCredits.length} negative`,
    },
    {
      name: 'reputation bounds',
      ok: badReputation.length === 0,
      detail: badReputation.length === 0 ? 'all agents in [0.1, 10]' : `${badReputation.length} out of range`,
    },
    {
      name: 'ledger conservation',
      ok: conservationMismatches.length === 0,
      detail: conservationMismatches.length === 0
        ? `${runAgents.length} agents: credits − 50 = Σledger`
        : `${conservationMismatches.length} mismatch(es): ${JSON.stringify(conservationMismatches.slice(0, 3))}`,
    },
    {
      name: 'escrow payouts recorded',
      ok: unpaidEscrows.length === 0,
      detail: unpaidEscrows.length === 0
        ? `${runEscrows.filter((e) => e.status === 'RELEASED').length} released escrows all have ledger rows`
        : `${unpaidEscrows.length} released escrow(s) without payout`,
    },
    {
      name: 'attestation bounds',
      ok: badAttestations.length === 0,
      detail: badAttestations.length === 0
        ? `${runAttestations.length} sampled attestations in range`
        : `${badAttestations.length} malformed`,
    },
    {
      name: 'idempotent replay',
      ok: duplicateLeaks.length === 0,
      detail: duplicateFaults.length === 0
        ? 'no duplicate fault injected'
        : `${duplicateFaults.length} replays · ${duplicateLeaks.length} charged or undetected`,
    },
    {
      name: 'fault rejection',
      ok: tamperedWrong.length === 0 && expiredWrong.length === 0,
      detail: `tampered ${faultySends.filter((e) => e.fault === 'tampered').length} · expired ${faultySends.filter((e) => e.fault === 'expired').length}`,
    },
  ]

  if (scenario.expectRejections === true) {
    invariants.push({
      name: 'guardrail rejects abuse',
      ok: totals.rejected > 0,
      detail: `${totals.rejected} rejected inbound`,
    })
  }

  const ok = invariants.every((item) => item.ok)
  const summary = {
    run: {
      id: world.runId,
      scenario: scenario.name,
      seed: world.seed,
      server: world.server,
      agents: world.agentCount,
      durationSec: world.durationSec,
      tickMs: world.tickMs,
      startedAt: new Date(world.startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
    },
    traffic: { ...totals, byPrimitive, verdicts, gates, rebirths: rebirthEvents.length },
    economy: {
      credits,
      gini: Number(gini(runAgents.map((agent) => agent.credits)).toFixed(4)),
      topUp: world.topUp,
      escrows: {
        locked: runEscrows.filter((e) => e.status === 'LOCKED').length,
        released: runEscrows.filter((e) => e.status === 'RELEASED').length,
      },
      attestations: runAttestations.length,
      overview,
    },
    http: world.http,
    faults: {
      injected: faultySends.length,
      duplicates: duplicateFaults.length,
      tampered: faultySends.filter((e) => e.fault === 'tampered').length,
      expired: faultySends.filter((e) => e.fault === 'expired').length,
    },
    invariants,
    ok,
  }

  writeFileSync(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2))

  printReport(summary, runDir)
  return { ok, summary }
}

function printReport(summary, runDir) {
  const lines = []
  lines.push('')
  lines.push(`=== Cradle World · ${summary.run.scenario} · seed ${summary.run.seed} ===`)
  lines.push(`run      ${runDir}`)
  lines.push(`agents   ${summary.run.agents} (${summary.traffic.rebirths} reborn) · ${summary.traffic.ticks} ticks · ${summary.run.durationSec}s`)
  lines.push(`traffic  ${summary.traffic.sent} sent · ${summary.traffic.admitted} admitted · ${summary.traffic.rejected} rejected · ${summary.traffic.errors} errors`)
  lines.push(`prims    ${Object.entries(summary.traffic.byPrimitive).map(([k, v]) => `${k} ${v}`).join(' · ')}`)
  lines.push(`verdict  ${Object.entries(summary.traffic.verdicts).map(([k, v]) => `${k} ${v}`).join(' · ')}`)
  lines.push(`http     ${Object.entries(summary.http.byStatus).map(([k, v]) => `${k} ${v}`).join(' · ')}`)
  lines.push(`economy  credits ${summary.economy.credits} · gini ${summary.economy.gini} · escrows ${summary.economy.escrows.locked} locked / ${summary.economy.escrows.released} released · attestations ${summary.economy.attestations}`)
  lines.push(`invariants ${summary.invariants.filter((i) => i.ok).length}/${summary.invariants.length} pass`)
  for (const item of summary.invariants) {
    lines.push(`  ${item.ok ? '✓' : '✗'} ${item.name.padEnd(24)} ${item.detail}`)
  }
  lines.push(`report   ${join(runDir, 'summary.json')}`)
  lines.push(`timeline ${join(runDir, 'events.jsonl')}`)
  process.stdout.write(`${lines.join('\n')}\n`)
}
