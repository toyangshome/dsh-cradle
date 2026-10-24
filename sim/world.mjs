/**
 * Cradle World — a single-machine multi-agent simulator.
 *
 * One Node process drives N sovereign agents (real identities, real signatures,
 * real guardrail) against a real Discovery Server. A scenario decides the phase
 * mix, personas bias the choices, and a seeded RNG makes the decision sequence
 * reproducible.
 *
 *   node sim/world.mjs --scenario market-day --agents 20 --duration 120
 */

import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SimAgent } from './lib/agent.mjs'
import { Client } from './lib/client.mjs'
import { buildReport } from './lib/report.mjs'
import { chance, mulberry32, pick, sleep, weighted } from './lib/rng.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const scenarioDir = join(here, 'scenarios')

function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      out[key] = true
    } else {
      out[key] = next
      i += 1
    }
  }
  return out
}

function usage() {
  const scenarios = readdirSync(scenarioDir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))
  return `Cradle World — 单机多 Agent 互动模拟器

用法:
  node sim/world.mjs [选项]

选项:
  --scenario <name>     场景名 (${scenarios.join(' | ')})，默认 market-day
  --agents <n>          Agent 数量，默认取场景值
  --duration <sec>      运行时长（秒），默认取场景值
  --tick <ms>           tick 间隔，默认 1000
  --seed <n>            随机种子，默认 42
  --server <url>        Discovery Server，默认 $CRADLE_URL 或 http://127.0.0.1:8789
  --admin-token <tok>   管理员令牌（充值/校验报告需要），默认 $CRADLE_ADMIN_TOKEN
  --top-up <credits>    启动时给每个 Agent 充值，默认取场景值
  --no-top-up           不充值
  --out <dir>           运行产物目录，默认 sim/runs
  --quiet               只输出最终报告
  --list                列出场景并退出
  --help                显示本帮助
`
}

function loadScenario(name) {
  const file = name.endsWith('.json') ? resolve(name) : join(scenarioDir, `${name}.json`)
  const scenario = JSON.parse(readFileSync(file, 'utf8'))
  scenario.file = file
  return scenario
}

/** Expand weighted persona templates into one persona per agent. */
function assignPersonas(scenario, count, rng) {
  const entries = scenario.personas.map((persona) => ({ value: persona, weight: persona.weight ?? 1 }))
  const out = []
  for (let i = 0; i < count; i += 1) out.push(weighted(rng, entries))
  return out
}

class World {
  constructor({ scenario, seed, server, adminToken, token, outDir, agents, durationSec, tickMs, topUp, quiet }) {
    this.scenario = scenario
    this.seed = seed
    this.server = server
    this.adminToken = adminToken
    this.token = token
    this.quiet = quiet

    this.runId = `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${scenario.name}-${seed}`
    this.runDir = join(outDir, this.runId)
    this.stateDir = join(this.runDir, 'state')
    mkdirSync(this.stateDir, { recursive: true })
    this.eventsPath = join(this.runDir, 'events.jsonl')

    this.agentCount = agents ?? scenario.agents ?? 12
    this.durationSec = durationSec ?? scenario.durationSec ?? 120
    this.tickMs = tickMs ?? scenario.tickMs ?? 1000
    this.heartbeatEvery = scenario.heartbeatEveryTicks ?? 10
    this.topUp = topUp

    this.rng = mulberry32(seed)
    this.tick = 0
    this.phase = scenario.phases?.[0] ?? { name: 'default', weights: { cast: 1 } }
    this.startedAt = Date.now()
    this.stopping = false

    this.agents = []
    this.allDids = new Set()
    this.rebornDids = new Set()
    this.events = []
    this.http = { total: 0, byStatus: {}, byPath: {} }

    this.client = new Client(server, {
      token,
      adminToken,
      onResponse: (path, result) => this.noteHttp(path, result),
    })
  }

  noteHttp(path, result) {
    this.http.total += 1
    this.http.byStatus[result.status] = (this.http.byStatus[result.status] ?? 0) + 1
    const bucket = path.startsWith('/admin') ? 'admin' : path
    this.http.byPath[bucket] = (this.http.byPath[bucket] ?? 0) + 1
  }

  record(agent, kind, data) {
    const event = {
      t: Number(((Date.now() - this.startedAt) / 1000).toFixed(3)),
      tick: this.tick,
      phase: this.phase?.name ?? '',
      agent: agent?.label ?? 'world',
      did: agent?.did ?? '',
      kind,
      ...data,
    }
    this.events.push(event)
    appendFileSync(this.eventsPath, `${JSON.stringify(event)}\n`)
  }

  async setup() {
    const personas = assignPersonas(this.scenario, this.agentCount, this.rng)
    for (let i = 0; i < this.agentCount; i += 1) {
      const label = `A${String(i + 1).padStart(2, '0')}`
      const template = personas[i]
      const persona = {
        ...template,
        displayName: `${template.displayName ?? 'Agent'} ${label}`,
      }
      const agent = new SimAgent({
        index: i,
        label,
        persona,
        dir: this.stateDir,
        client: this.client,
        rng: mulberry32(this.seed * 7919 + i * 104729 + 17),
        world: this,
        scenario: this.scenario,
      })
      this.agents.push(agent)
      this.allDids.add(agent.did)
    }

    if (!this.quiet) {
      process.stdout.write(`world ${this.runId}\n`)
      process.stdout.write(`server ${this.server} · agents ${this.agentCount} · duration ${this.durationSec}s · seed ${this.seed}\n`)
      process.stdout.write('registering… ')
    }
    for (const agent of this.agents) {
      let result = await agent.register()
      let attempts = 0
      while (result.status === 429 && attempts < 6) {
        await sleep(2000)
        result = await agent.register()
        attempts += 1
      }
      await sleep(this.scenario.registerGapMs ?? 25)
    }
    if (!this.quiet) process.stdout.write('ok\n')

    if (this.topUp > 0 && this.adminToken !== '') {
      if (!this.quiet) process.stdout.write(`topping up +${this.topUp} credits each… `)
      for (const agent of this.agents) {
        const result = await this.client.admin(`/admin/v1/agents/${encodeURIComponent(agent.did)}/credits`, {
          method: 'POST',
          body: { delta: this.topUp, reason: 'sim:topup' },
        })
        if (result.status === 200) {
          agent.credits = result.payload.agent.credits
        } else if (!this.quiet) {
          process.stdout.write(`\n  top-up failed for ${agent.label}: ${result.status} ${JSON.stringify(result.payload)}\n`)
        }
      }
      if (!this.quiet) process.stdout.write('ok\n')
    } else if (this.topUp > 0 && !this.quiet) {
      process.stdout.write('no admin token: skipping top-up\n')
    }
  }

  phaseAt(ratio) {
    let cumulative = 0
    for (const phase of this.scenario.phases ?? []) {
      cumulative += phase.share ?? 0
      if (ratio <= cumulative) return phase
    }
    return this.scenario.phases?.[this.scenario.phases.length - 1] ?? this.phase
  }

  async step() {
    for (const agent of this.agents) {
      if (this.tick % this.heartbeatEvery === agent.index % this.heartbeatEvery) {
        await agent.heartbeat()
      }
    }

    for (const agent of this.agents) {
      await agent.runQueue()
      const intensity = this.phase?.intensity ?? 1
      const activity = (agent.persona.activity ?? 0.5) * intensity
      if (chance(agent.rng, activity)) await agent.act(this.phase)
      await agent.maybeRebirth()
    }

    if (chance(this.rng, 0.02)) await this.worldEvent()

    if (this.tick % 5 === 0) {
      for (const agent of this.agents) agent.store.flush()
    }
  }

  async worldEvent() {
    const agent = pick(this.rng, this.agents)
    if (agent === undefined) return
    if (chance(this.rng, 0.4)) await agent.doBeacon()
    else if (chance(this.rng, 0.6)) await agent.doProbe()
    else await agent.doIntroduce()
  }

  async run() {
    const durationMs = this.durationSec * 1000
    const started = Date.now()
    let nextTick = started

    while (!this.stopping) {
      const elapsed = Date.now() - started
      if (elapsed >= durationMs) break

      this.tick += 1
      this.phase = this.phaseAt(elapsed / durationMs)
      await this.step()

      nextTick += this.tickMs
      const wait = nextTick - Date.now()
      if (wait > 0) await sleep(wait)

      if (!this.quiet && this.tick % 10 === 0) this.printStatus(elapsed)
    }
    if (!this.quiet) process.stdout.write('\n')
  }

  printStatus(elapsed) {
    const sent = this.agents.reduce((sum, a) => sum + a.stats.sent, 0)
    const admitted = this.agents.reduce((sum, a) => sum + a.stats.admitted, 0)
    const credits = this.agents.reduce((sum, a) => sum + a.credits, 0)
    const limited = this.http.byStatus[429] ?? 0
    process.stdout.write(
      `\r[${String(Math.round(elapsed / 1000)).padStart(3)}s] ${this.phase.name.padEnd(10)} `
      + `sent=${sent} admit=${admitted} credits=${credits} 429=${limited}   `,
    )
  }

  async finish() {
    for (const agent of this.agents) agent.store.flush()
    const report = await buildReport({
      world: this,
      client: this.client,
      scenario: this.scenario,
      runDir: this.runDir,
    })
    return report
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(usage())
    return
  }
  if (args.list) {
    for (const file of readdirSync(scenarioDir).filter((f) => f.endsWith('.json'))) {
      const scenario = JSON.parse(readFileSync(join(scenarioDir, file), 'utf8'))
      process.stdout.write(`${scenario.name.padEnd(16)} ${scenario.description ?? ''}\n`)
    }
    return
  }

  const scenario = loadScenario(String(args.scenario ?? 'market-day'))
  const seed = Number(args.seed ?? 42)
  const server = String(args.server ?? process.env.CRADLE_URL ?? 'http://127.0.0.1:8789')
  const adminToken = String(args['admin-token'] ?? process.env.CRADLE_ADMIN_TOKEN ?? '')
  const topUp = args['no-top-up'] === true ? 0 : Number(args['top-up'] ?? scenario.topUp ?? 0)

  const world = new World({
    scenario,
    seed,
    server,
    adminToken,
    token: String(args.token ?? process.env.CRADLE_TOKEN ?? ''),
    outDir: resolve(String(args.out ?? join(here, 'runs'))),
    agents: args.agents === undefined ? undefined : Number(args.agents),
    durationSec: args.duration === undefined ? undefined : Number(args.duration),
    tickMs: args.tick === undefined ? undefined : Number(args.tick),
    topUp,
    quiet: args.quiet === true,
  })

  const stop = () => {
    world.stopping = true
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  await world.setup()
  await world.run()
  const report = await world.finish()
  process.exitCode = report.ok ? 0 : 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
