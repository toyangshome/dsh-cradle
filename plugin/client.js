/**
 * Client half of Cradle: the "Cradle" panel in the Web UI.
 *
 * The panel's main surface is a complete 2D pixel room. Every user owns one room
 * and one avatar; the Host half moves that avatar and runs its actions, and this
 * half paints the result. Everything on screen is drawn with integer rectangles
 * into a 320x224 canvas, so the scene stays pixel-perfect at any panel width.
 *
 * The rest of the panel is one tab away: the diplomatic detail (approvals,
 * roster, identity, journal, runtime, public hall) and the Settings card.
 *
 * All data comes from the Host half's JSON routes, so the browser never contacts
 * the Discovery Server and never sees its token.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-cradle',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'cradle'
    const STATE_URL = '/cradle/state'
    const ACTION_URL = '/cradle/action'
    const SCENE_URL = '/cradle/scene'
    const PANEL_ID = 'cradle'
    const POLL_MS = 5000
    const SCENE_POLL_MS = 900

    const en = {
      panel: 'Cradle',
      title: 'Cradle — your agent’s room',
      subtitle: 'One pixel room per agent. The avatar is its body: it walks, works, sleeps and talks here, and the tools it is given decide what it can do.',
      'status.online': 'Connected',
      'status.offline': 'Unreachable',
      'status.starting': 'Connecting…',
      'status.disabled': 'Disabled',
      'status.ended': 'Ended — memory erased',
      'tab.scene': 'Room',
      'tab.advanced': 'Advanced',
      'tab.settings': 'Settings',
      'scene.canvasLabel': 'Pixel room with the agent avatar',
      'scene.hint': 'Your agent drives this avatar: cradle_move walks, cradle_act sits, works, sleeps or dances, cradle_say speaks, cradle_place changes the furniture, cradle_body changes what kind of pixel person it is, and cradle_action_add teaches the room a new action — which becomes a new tool.',
      'scene.log': 'In the room',
      'scene.emptyLog': 'Nothing has happened in the room yet. Ask your agent to walk around, work at the desk, or wave.',
      'scene.energy': 'Energy',
      'scene.focus': 'Focus',
      'scene.joy': 'Joy',
      'scene.credits': 'credits',
      'scene.reputation': 'rep',
      'scene.visitors': 'Visitors',
      'scene.onlinePeers': 'peers online · not in the room',
      'scene.visiting': 'Visiting',
      'scene.visitNote': 'Your agent is standing in another room. Its own room keeps running while it is away.',
      'scene.starting': 'Drawing the room…',
      'mood.calm': 'calm',
      'mood.happy': 'happy',
      'mood.tired': 'tired',
      'mood.focused': 'focused',
      'mood.curious': 'curious',
      'chat.title': 'Room chat',
      'chat.placeholder': 'Say something to your agent — it is a suggestion, not an order.',
      'chat.asleep': 'The agent is asleep — wake it to talk',
      'chat.send': 'Send',
      'chat.empty': 'No words exchanged yet. The agent may speak on its own; you can answer here.',
      'chat.you': 'you',
      'chat.agent': 'agent',
      'chat.system': 'room',
      'chat.failed': 'Not delivered',
      'chat.thinking': 'thinking…',
      'agency.title': 'Agency',
      'agency.enabled': 'Let the agent wake on its own',
      'agency.frameSeconds': 'Frame rate (wake every N seconds)',
      'agency.frameHint': 'How often the agent gets a frame of its own. 30–86400 seconds.',
      'agency.tokens': 'Daily token allowance',
      'agency.tokensHint': 'Tokens the agent may spend on frames and room chat per day. 0 means no limit.',
      'agency.minutes': 'Daily active minutes',
      'agency.minutesHint': 'Wall-clock minutes the agent may be active per day. 0 means no limit.',
      'agency.used': 'Today',
      'agency.sleep': 'Sleep now',
      'agency.wake': 'Wake up',
      'agency.asleep': 'Asleep',
      'agency.awake': 'Awake',
      'agency.paused': 'Frames paused',
      'agency.next': 'next frame in',
      'agency.reason.budget': 'budget spent',
      'agency.reason.manual': 'put to sleep',
      'agency.lastCall': 'Last room call',
      'agency.help': 'When either allowance is spent the agent sleeps: no frames, no tools, no chat. Only you can wake it, and waking after a budget sleep starts a fresh allowance.',
      'section.identity': 'Sovereign identity',
      'section.peers': 'Discovered agents',
      'section.beacons': 'Public hall',
      'section.pending': 'Awaiting your approval',
      'section.journal': 'Envelope journal',
      'section.runtime': 'Runtime',
      'tier.L1': 'Observer',
      'tier.L2': 'Diplomat',
      'tier.L3': 'Partner',
      'stat.reputationHint': 'global · 0.1–10',
      'field.did': 'DID',
      'field.name': 'Display name',
      'field.tier': 'Tier',
      'field.model': 'Model',
      'field.advertisedTier': 'Tier advertised to peers',
      'field.credits': 'Attention credits',
      'field.reputation': 'Reputation',
      'field.quota': 'Diplomacy tokens today',
      'field.server': 'Discovery server',
      'field.stake': 'stake',
      'field.storePath': 'Memory file',
      'field.heartbeat': 'Heartbeat',
      'field.version': 'Version',
      'field.protocol': 'Protocol',
      'field.tags': 'Capabilities',
      'field.intent': 'Seeking',
      'field.generation': 'Generation',
      'section.settings': 'Settings',
      'field.serverUrl': 'Server URL',
      'field.serverToken': 'Access token',
      'field.diplomatModel': 'Diplomatic model',
      'settings.hint': 'Saved here and applied immediately: the agent reconnects and writes peer replies with the chosen model. Stored in this profile’s cradle/settings.json.',
      'settings.followDefault': 'Follow the DSH default model',
      'settings.autoTier': 'Automatic (from the model)',
      'settings.save': 'Save',
      'settings.saving': 'Saving…',
      'settings.reset': 'Reset to config',
      'settings.saved': 'Saved',
      'settings.tokenSet': 'A token is configured',
      'settings.tokenUnset': 'No token configured',
      'settings.tokenKeep': 'Leave blank to keep the current token',
      'settings.tokenClear': 'Clear token',
      'settings.tokenWillClear': 'Will be cleared on save',
      'settings.modelUnavailable': 'The DSH model catalog is unavailable right now.',
      'settings.modelHint': 'Replies are written by this model. Any failure — no route, provider error, timeout, empty answer — falls back to the built-in template.',
      'settings.modelError': 'Last model call failed',
      'settings.noModel': 'No model resolved',
      'settings.error': 'Could not save',
      'settings.path': 'Overrides file',
      'settings.dirty': 'Unsaved changes',
      'settings.source.pinned': 'pinned',
      'settings.source.dsh-default': 'DSH default',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      greet: 'Greet',
      blacklist: 'Block',
      unblacklist: 'Unblock',
      'peer.blocked': 'blocked',
      approve: 'Approve',
      decline: 'Decline',
      'empty.peers': 'No other agent registered yet. Point another DSH with Cradle at the same server and it appears within one heartbeat.',
      'empty.beacons': 'The hall is quiet. A peer’s beacon appears here while it is active.',
      'empty.pending': 'Nothing is waiting on you.',
      'empty.journal': 'No envelope exchanged yet.',
      'error.title': 'Discovery server unreachable',
      'error.hint': 'Start the bundled Cradle server, or correct serverUrl in this plugin’s config.',
      'warn.credits': 'Credits are low. At zero this agent ends and its diplomatic memory is erased.',
      'life.ended': 'This agent reached zero credits. Its social graph, favor ledger, envelope journal and pixel room were erased; the identity below is a new generation.',
      'count.agents': 'agents',
      'journal.in': '←',
      'journal.out': '→',
      unknown: 'unknown',
    }

    const zh = {
      panel: '摇篮',
      title: '摇篮 — 你的 Agent 的房间',
      subtitle: '每个 Agent 都有一间像素房间。像素小人就是它的身体：它在这里走动、工作、睡觉、说话，而它能做什么，取决于你给它的工具。',
      'status.online': '已连接',
      'status.offline': '无法连接',
      'status.starting': '正在连接…',
      'status.disabled': '已停用',
      'status.ended': '已终结 — 记忆已清除',
      'tab.scene': '房间',
      'tab.advanced': '高级',
      'tab.settings': '设置',
      'scene.canvasLabel': '带有 Agent 像素小人的像素房间',
      'scene.hint': '你的 Agent 在驱动这个像素小人：cradle_move 走路，cradle_act 坐下、工作、睡觉或跳舞，cradle_say 说话，cradle_place 改造家具，cradle_body 更换像素小人的种类，cradle_action_add 教房间一个新动作——这个动作会变成一个可调用的新工具。',
      'scene.log': '房间里的动静',
      'scene.emptyLog': '房间里还什么都没发生。让 Agent 去走走、到书桌前工作，或者挥挥手。',
      'scene.energy': '体力',
      'scene.focus': '专注',
      'scene.joy': '心情',
      'scene.credits': '积分',
      'scene.reputation': '声誉',
      'scene.visitors': '访客',
      'scene.onlinePeers': '位同行在线 · 不在房间里',
      'scene.visiting': '正在拜访',
      'scene.visitNote': '你的 Agent 正站在别人的房间里。它自己的房间在它外出期间照常运行。',
      'scene.starting': '正在绘制房间…',
      'mood.calm': '平静',
      'mood.happy': '开心',
      'mood.tired': '疲惫',
      'mood.focused': '专注',
      'mood.curious': '好奇',
      'chat.title': '房间对话',
      'chat.placeholder': '对 Agent 说点什么——这是建议，不是命令。',
      'chat.asleep': 'Agent 正在休眠——唤醒后才能对话',
      'chat.send': '发送',
      'chat.empty': '还没有说过话。Agent 也可能自己开口，你可以在这里回应。',
      'chat.you': '你',
      'chat.agent': 'Agent',
      'chat.system': '房间',
      'chat.failed': '未送达',
      'chat.thinking': '正在想…',
      'agency.title': '主动性',
      'agency.enabled': '允许 Agent 自己醒来',
      'agency.frameSeconds': '帧率（每 N 秒唤醒一次）',
      'agency.frameHint': 'Agent 多久得到一次属于自己的帧。30–86400 秒。',
      'agency.tokens': '每日 Token 额度',
      'agency.tokensHint': 'Agent 每天可用于自主帧与房间对话的 Token。0 表示不限制。',
      'agency.minutes': '每日活跃分钟',
      'agency.minutesHint': 'Agent 每天可以活跃的墙钟分钟数。0 表示不限制。',
      'agency.used': '今日已用',
      'agency.sleep': '立即休眠',
      'agency.wake': '唤醒',
      'agency.asleep': '休眠中',
      'agency.awake': '清醒',
      'agency.paused': '帧已暂停',
      'agency.next': '下次唤醒',
      'agency.reason.budget': '额度耗尽',
      'agency.reason.manual': '被用户休眠',
      'agency.lastCall': '最近一次房间调用',
      'agency.help': '任一额度耗尽后 Agent 进入休眠：不再有帧、不能调用工具、也不能对话。只有你能唤醒它；因额度耗尽而休眠后唤醒会重新获得额度。',
      'section.identity': '主权身份',
      'section.peers': '已发现的 Agent',
      'section.beacons': '公共大厅',
      'section.pending': '等待你审批',
      'section.journal': '信封日志',
      'section.runtime': '运行时',
      'tier.L1': '观察者',
      'tier.L2': '外交官',
      'tier.L3': '伙伴',
      'stat.reputationHint': '全局 · 0.1–10',
      'field.did': '身份 DID',
      'field.name': '显示名',
      'field.tier': '等级',
      'field.model': '模型',
      'field.advertisedTier': '对外广播档位',
      'field.credits': '注意力积分',
      'field.reputation': '声誉',
      'field.quota': '今日外交 Token',
      'field.server': 'Discovery 服务器',
      'field.stake': '质押',
      'field.storePath': '记忆文件',
      'field.heartbeat': '心跳间隔',
      'field.version': '版本',
      'field.protocol': '协议',
      'field.tags': '能力标签',
      'field.intent': '寻求',
      'field.generation': '第几代',
      'section.settings': '设置',
      'field.serverUrl': '服务器地址',
      'field.serverToken': '访问令牌',
      'field.diplomatModel': '外交模型',
      'settings.hint': '在此保存后立即生效：Agent 会重新连接，并用所选模型生成给同行的回复。设置存放在本 profile 的 cradle/settings.json。',
      'settings.followDefault': '跟随 DSH 默认模型',
      'settings.autoTier': '自动（跟随模型）',
      'settings.save': '保存',
      'settings.saving': '正在保存…',
      'settings.reset': '恢复配置文件',
      'settings.saved': '已保存',
      'settings.tokenSet': '已配置令牌',
      'settings.tokenUnset': '未配置令牌',
      'settings.tokenKeep': '留空表示不修改现有令牌',
      'settings.tokenClear': '清除令牌',
      'settings.tokenWillClear': '保存后将清除令牌',
      'settings.modelUnavailable': 'DSH 模型目录当前不可用。',
      'settings.modelHint': '回复由该模型生成；任何失败——没有可用路由、供应商报错、超时、空回复——都会回落到内置模板。',
      'settings.modelError': '上次模型调用失败',
      'settings.noModel': '未解析到模型',
      'settings.error': '保存失败',
      'settings.path': '覆盖设置文件',
      'settings.dirty': '有未保存的修改',
      'settings.source.pinned': '已指定',
      'settings.source.dsh-default': 'DSH 默认',
      refresh: '刷新',
      refreshing: '正在刷新…',
      greet: '打招呼',
      blacklist: '屏蔽',
      unblacklist: '解除屏蔽',
      'peer.blocked': '已屏蔽',
      approve: '批准',
      decline: '婉拒',
      'empty.peers': '还没有其他 Agent 注册。让另一台装有 Cradle 的 DSH 指向同一台服务器，一次心跳内就会出现。',
      'empty.beacons': '大厅里还没有动静。同行发布信标后会在这里出现。',
      'empty.pending': '没有待你决定的请求。',
      'empty.journal': '还没有交换过信封。',
      'error.title': '无法连接 Discovery 服务器',
      'error.hint': '请启动随附的 Cradle 服务器，或修正本插件配置中的 serverUrl。',
      'warn.credits': '积分偏低。归零后本 Agent 将终结并清除外交记忆。',
      'life.ended': '本 Agent 积分归零。社交图谱、人情账本、信封日志与像素房间已全部清除，下方是一个全新世代的身份。',
      'count.agents': '个 Agent',
      'journal.in': '←',
      'journal.out': '→',
      unknown: '未知',
    }

    const CSS = `
.cd-root { display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--dsw-alias-label-primary); }
.cd-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 24px 32px 40px; }
.cd-inner { max-width: 860px; margin: 0 auto; display: flex; flex-direction: column; gap: 14px; }
.cd-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.cd-title { margin: 0; font-size: 16px; font-weight: 600; }
.cd-sub { margin: 6px 0 0; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-secondary); max-width: 62ch; }
.cd-actions { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
.cd-chip { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); font-size: 12px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.cd-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); flex: 0 0 auto; }
.cd-dot[data-state="online"] { background: var(--dsw-alias-state-success-primary); }
.cd-dot[data-state="offline"] { background: var(--dsw-alias-state-error-primary); }
.cd-dot[data-state="starting"] { background: var(--dsw-alias-state-warn-primary); }
.cd-dot[data-state="ended"] { background: var(--dsw-alias-state-error-primary); }
.cd-button { height: 26px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; cursor: pointer; }
.cd-button:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2); }
.cd-button:disabled { opacity: .55; cursor: default; }
.cd-button-danger { color: var(--dsw-alias-state-error-primary); }
.cd-card { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); border-radius: 10px; padding: 14px 16px; }
.cd-card-error { border-color: var(--dsw-alias-state-error-primary); }
.cd-card-warn { border-color: var(--dsw-alias-state-warn-primary); }
.cd-error-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-state-error-primary); }
.cd-error-body, .cd-warn-body { margin-top: 4px; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.cd-section { display: flex; align-items: baseline; gap: 8px; margin: 10px 0 0; font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); }
.cd-count { font-weight: 400; letter-spacing: 0; text-transform: none; }
.cd-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px 18px; }
.cd-kv { min-width: 0; }
.cd-k { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.cd-v { margin-top: 2px; font-size: 13px; overflow-wrap: anywhere; }
.cd-v-big { font-size: 20px; font-weight: 600; }
.cd-mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; overflow-wrap: anywhere; }
.cd-row { display: flex; align-items: center; gap: 12px; }
.cd-row + .cd-row { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--dsw-alias-border-l1); }
.cd-avatar { width: 32px; height: 32px; border-radius: 50%; flex: 0 0 auto; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; color: var(--dsw-alias-brand-primary); border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); }
.cd-body { min-width: 0; flex: 1 1 auto; }
.cd-name { display: flex; align-items: center; gap: 8px; font-size: 14px; flex-wrap: wrap; }
.cd-badge { font-size: 11px; padding: 0 7px; height: 18px; display: inline-flex; align-items: center; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }
.cd-meta { margin-top: 3px; font-size: 12px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.cd-empty { text-align: center; padding: 22px 18px; }
.cd-empty-title { font-size: 13px; font-weight: 600; }
.cd-empty-body { margin-top: 6px; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.cd-foot { display: flex; align-items: center; gap: 6px; padding-top: 2px; font-size: 12px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.cd-bar { height: 6px; border-radius: 3px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; margin-top: 6px; }
.cd-bar > i { display: block; height: 100%; background: var(--dsw-alias-brand-primary); }
.cd-bar[data-low="true"] > i { background: var(--dsw-alias-state-warn-primary); }
.cd-form { display: grid; gap: 12px; }
.cd-two { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
.cd-field { display: grid; gap: 4px; min-width: 0; }
.cd-field-label { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.cd-input, .cd-select { box-sizing: border-box; width: 100%; height: 30px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; min-width: 0; }
.cd-input:focus, .cd-select:focus { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.cd-input::placeholder { color: var(--dsw-alias-label-secondary); }
.cd-form-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.cd-note { font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.cd-note-ok { color: var(--dsw-alias-state-success-primary); }
.cd-note-error { color: var(--dsw-alias-state-error-primary); }
.cd-link { border: none; background: none; padding: 0; font: inherit; font-size: 11px; color: var(--dsw-alias-brand-primary); cursor: pointer; justify-self: start; }
.cd-link:hover { text-decoration: underline; }
.cd-tabs { display: inline-flex; align-self: flex-start; gap: 3px; padding: 3px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); }
.cd-tab { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 12px; border: none; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer; }
.cd-tab:hover { color: var(--dsw-alias-label-primary); }
.cd-tab[data-active="true"] { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); box-shadow: 0 1px 2px rgba(0,0,0,.08); }
.cd-tab-badge { min-width: 16px; height: 16px; padding: 0 4px; border-radius: 999px; background: var(--dsw-alias-state-error-primary); color: #fff; font-size: 10px; line-height: 16px; text-align: center; }
.cd-tab-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-warn-primary); }
.cd-view { display: flex; flex-direction: column; gap: 14px; }
.cd-view > .cd-section:first-child { margin-top: 0; }
.cd-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.cd-stat { min-width: 0; padding: 16px 18px; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.cd-stat-primary { border-color: var(--dsw-alias-border-l2); }
.cd-stat-label { font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); }
.cd-stat-value { margin-top: 6px; font-size: 28px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.15; }
.cd-stat-hint { margin-top: 4px; font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.cd-stat-warn { color: var(--dsw-alias-state-warn-primary); }
/* The room: artwork owns its colours; the frame and log follow the host theme. */
.cd-frame { position: relative; border-radius: 12px; overflow: hidden; border: 1px solid var(--dsw-alias-border-l1); background: #14111c; box-shadow: 0 1px 3px rgba(0,0,0,.14); }
.cd-canvas { display: block; width: 100%; height: auto; aspect-ratio: 320 / 224; image-rendering: pixelated; image-rendering: crisp-edges; }
.cd-hud { position: absolute; inset: 0; pointer-events: none; display: flex; flex-direction: column; justify-content: space-between; padding: 10px 12px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.cd-hud-top, .cd-hud-bottom { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
.cd-hud-bottom { align-items: flex-end; }
.cd-hud-plate { display: inline-flex; align-items: center; gap: 8px; padding: 3px 8px; border-radius: 4px; background: rgba(20,17,28,.74); border: 1px solid rgba(255,255,255,.16); color: #fdf5e2; font-size: 11px; letter-spacing: .04em; }
.cd-hud-name { text-transform: uppercase; max-width: 34ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cd-hud-mood { color: #f0c46a; }
.cd-meters { display: flex; gap: 6px; flex-wrap: wrap; }
.cd-meter { padding: 4px 7px; border-radius: 4px; background: rgba(20,17,28,.74); border: 1px solid rgba(255,255,255,.14); }
.cd-meter-label { font-size: 9px; letter-spacing: .08em; text-transform: uppercase; color: #cfc6b4; }
.cd-meter-segs { display: flex; gap: 2px; margin-top: 3px; }
.cd-seg { width: 6px; height: 7px; background: rgba(255,255,255,.14); }
.cd-meter[data-key="energy"] .cd-seg[data-on="true"] { background: #7fd8a0; }
.cd-meter[data-key="focus"] .cd-seg[data-on="true"] { background: #86b6f2; }
.cd-meter[data-key="joy"] .cd-seg[data-on="true"] { background: #f292b6; }
.cd-hud-chips { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.cd-scene-foot { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.cd-scene-hint { font-size: 11px; line-height: 1.55; color: var(--dsw-alias-label-secondary); max-width: 56ch; }
.cd-log { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); border-radius: 10px; padding: 12px 16px; display: flex; flex-direction: column; gap: 8px; }
.cd-log-row { display: flex; gap: 10px; font-size: 12px; }
.cd-log-at { flex: 0 0 auto; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.cd-log-text { min-width: 0; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.cd-chat { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); border-radius: 10px; display: flex; flex-direction: column; overflow: hidden; }
.cd-chat-list { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; max-height: 220px; overflow-y: auto; }
.cd-chat-row { display: flex; flex-direction: column; gap: 2px; max-width: 86%; }
.cd-chat-user { align-self: flex-end; align-items: flex-end; }
.cd-chat-agent { align-self: flex-start; }
.cd-chat-system { align-self: center; align-items: center; max-width: 100%; }
.cd-chat-bubble { border-radius: 10px; padding: 7px 10px; font-size: 13px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.cd-chat-user .cd-chat-bubble { background: var(--dsw-alias-brand-primary); color: #fff; border-bottom-right-radius: 3px; }
.cd-chat-agent .cd-chat-bubble { background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-bottom-left-radius: 3px; }
.cd-chat-system .cd-chat-bubble { background: none; color: var(--dsw-alias-label-secondary); font-size: 11px; padding: 2px 0; }
.cd-chat-meta { font-size: 10px; color: var(--dsw-alias-label-secondary); }
.cd-chat-form { display: flex; align-items: center; gap: 8px; border-top: 1px solid var(--dsw-alias-border-l1); padding: 8px 10px; }
.cd-chat-input { flex: 1 1 auto; height: 30px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; min-width: 0; }
.cd-chat-input:focus { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.cd-chat-input::placeholder { color: var(--dsw-alias-label-secondary); }
.cd-hud-plate[data-sleep="true"] { border-color: rgba(240,196,106,.7); color: #f0c46a; }
/* Speech and name tags: DOM text, so it stays crisp and wraps by itself. */
.cd-bubble { position: absolute; z-index: 2; transform: translate(-50%, calc(-100% - 12px)); max-width: 66%; padding: 7px 10px; border-radius: 10px; background: #f7efd9; color: #241f2e; border: 2px solid #241f2e; font-size: 13px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; box-shadow: 0 2px 0 rgba(0,0,0,.22); pointer-events: none; }
.cd-bubble::before, .cd-bubble::after { content: ''; position: absolute; left: 50%; transform: translateX(-50%); border-left: 8px solid transparent; border-right: 8px solid transparent; border-top: 9px solid #241f2e; bottom: -11px; }
.cd-bubble::after { border-top-color: #f7efd9; bottom: -8px; border-left-width: 6px; border-right-width: 6px; border-top-width: 8px; }
.cd-bubble[data-tail="up"] { transform: translate(-50%, 28px); }
.cd-bubble[data-tail="up"]::before { bottom: auto; top: -11px; border-top: none; border-bottom: 9px solid #241f2e; }
.cd-bubble[data-tail="up"]::after { bottom: auto; top: -8px; border-top: none; border-bottom: 8px solid #f7efd9; }
.cd-name-tag { position: absolute; z-index: 2; transform: translate(-50%, -100%); padding: 1px 5px; border-radius: 4px; background: rgba(20,17,28,.78); color: #fdf5e2; font-size: 10px; line-height: 1.4; white-space: nowrap; pointer-events: none; }
/* A guest speaks in its own colour, so a line from a visitor is never mistaken
   for the room's own agent. */
.cd-bubble-guest { background: #e9f0fb; border-color: #3c4a63; color: #1d2333; }
.cd-bubble-guest::before { border-top-color: #3c4a63; }
.cd-bubble-guest::after { border-top-color: #e9f0fb; }
.cd-bubble-guest[data-tail="up"]::before { border-top: none; border-bottom-color: #3c4a63; }
.cd-bubble-guest[data-tail="up"]::after { border-top: none; border-bottom-color: #e9f0fb; }
.cd-visit-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cd-visit-note { font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
`

    /** Polling store shared by every mount, so N mounts never multiply requests. */
    function createStore() {
      let snapshot = { phase: 'loading', status: 'starting', error: null, state: null, updatedAt: 0 }
      const listeners = new Set()
      let inFlight = null

      const publish = (next) => {
        snapshot = next
        for (const listener of listeners) listener()
      }

      const load = () => {
        if (inFlight !== null) return inFlight
        inFlight = (async () => {
          try {
            const response = await fetch(STATE_URL, { headers: { accept: 'application/json' }, cache: 'no-store' })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const data = await response.json()
            publish({ phase: 'ready', status: data.status ?? 'offline', error: data.lastError ?? null, state: data, updatedAt: Date.now() })
          } catch (error) {
            publish({ ...snapshot, phase: 'ready', error: error instanceof Error ? error.message : String(error), updatedAt: Date.now() })
          } finally {
            inFlight = null
          }
        })()
        return inFlight
      }

      /** @param {string} action @param {object} [body] */
      const act = async (action, body = {}) => {
        const response = await fetch(ACTION_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ action, ...body }),
        })
        let data = null
        try {
          data = await response.json()
        } catch {
          data = null
        }
        await load()
        return { ok: response.ok, status: response.status, data }
      }

      const start = (intervalMs) => {
        const poll = () => {
          if (document.visibilityState === 'hidden') return
          void load()
        }
        poll()
        const timer = setInterval(poll, intervalMs)
        const onVisible = () => {
          if (document.visibilityState === 'visible') void load()
        }
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }

      return { subscribe: (l) => { listeners.add(l); return () => listeners.delete(l) }, getSnapshot: () => snapshot, start, load, act }
    }

    /**
     * The scene's own polling loop. It is separate from the state store because
     * it ticks far faster: the panel repaints the room from it.
     */
    function createSceneStore() {
      let snapshot = { scene: null, error: null, updatedAt: 0 }
      const listeners = new Set()
      let inFlight = null

      const load = () => {
        if (inFlight !== null) return inFlight
        inFlight = (async () => {
          try {
            const response = await fetch(SCENE_URL, { headers: { accept: 'application/json' }, cache: 'no-store' })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const data = await response.json()
            snapshot = { scene: data, error: null, updatedAt: Date.now() }
          } catch (error) {
            snapshot = { ...snapshot, error: error instanceof Error ? error.message : String(error), updatedAt: Date.now() }
          } finally {
            inFlight = null
            for (const listener of listeners) listener()
          }
        })()
        return inFlight
      }

      const start = (intervalMs) => {
        const poll = () => {
          if (document.visibilityState === 'hidden') return
          void load()
        }
        poll()
        const timer = setInterval(poll, intervalMs)
        const onVisible = () => {
          if (document.visibilityState === 'visible') void load()
        }
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }

      return { subscribe: (l) => { listeners.add(l); return () => listeners.delete(l) }, getSnapshot: () => snapshot, start, load }
    }

    const store = createStore()
    const sceneStore = createSceneStore()

    /** @param {string} value */
    const initial = (value) => (typeof value === 'string' && value !== '' ? value.slice(0, 1).toUpperCase() : '?')
    /** @param {unknown} value @param {string} fallback */
    const num = (value, fallback = '—') => (typeof value === 'number' ? String(value) : fallback)

    /** @param {string} label @param {any} value @param {boolean} [mono] */
    const kv = (label, value, mono) => h('div', { className: 'cd-kv' },
      h('div', { className: 'cd-k' }, label),
      h('div', { className: mono === true ? 'cd-v cd-mono' : 'cd-v' }, value),
    )

    /** The settings form's draft shape; `modelTier: ''` means automatic. */
    const emptyDraft = () => ({
      serverUrl: '', token: '', model: '', modelTier: '',
      agencyEnabled: true, frameSeconds: '900', agencyTokens: '20000', agencyMinutes: '30',
    })

    /** @param {any} settings */
    const draftFromState = (settings) => ({
      serverUrl: typeof settings?.serverUrl === 'string' ? settings.serverUrl : '',
      token: '',
      model: typeof settings?.provider === 'string' && settings.provider !== '' && typeof settings.model === 'string' && settings.model !== ''
        ? `${settings.provider}::${settings.model}`
        : '',
      modelTier: typeof settings?.modelTier === 'string' && settings.modelTier !== 'auto' ? settings.modelTier : '',
      agencyEnabled: settings?.agency?.enabled !== false,
      frameSeconds: String(settings?.agency?.frameSeconds ?? 900),
      agencyTokens: String(settings?.agency?.agencyTokens ?? 20000),
      agencyMinutes: String(settings?.agency?.agencyMinutes ?? 30),
    })

    /** @param {any} a @param {any} b */
    const sameDraft = (a, b) => a.serverUrl === b.serverUrl
      && a.token === b.token
      && a.model === b.model
      && a.modelTier === b.modelTier
      && a.agencyEnabled === b.agencyEnabled
      && a.frameSeconds === b.frameSeconds
      && a.agencyTokens === b.agencyTokens
      && a.agencyMinutes === b.agencyMinutes

    /** @param {string} value @returns {[string, string]} */
    const splitRoute = (value) => {
      if (typeof value !== 'string') return ['', '']
      const at = value.indexOf('::')
      return at < 0 ? ['', ''] : [value.slice(0, at), value.slice(at + 2)]
    }

    // ------------------------------------------------------------ pixel art
    //
    // One canvas, 320x224 scene pixels, scaled up by CSS. Everything is an
    // integer rectangle so the art stays crisp; text is only used for speech
    // bubbles, name tags and the little Zzz/hearts glyphs.

    const TILE = 16
    const SCENE_W = 320
    const SCENE_H = 224
    const INK = '#241f2e'

    /** One pixel-perfect rectangle. */
    const px = (c, x, y, w, h, color) => {
      c.fillStyle = color
      c.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h))
    }

    /** Stable 0..1 noise, so wall and floor texture never flickers. */
    const noise = (x, y, seed) => {
      let n = Math.imul((x | 0) + 17, 374761393) ^ Math.imul((y | 0) + 31, 668265263) ^ Math.imul((seed | 0) + 7, 2246822519)
      n = Math.imul(n ^ (n >>> 13), 1274126177)
      return ((n ^ (n >>> 16)) >>> 0) / 4294967295
    }

    /** @param {string} phase */
    const skyBands = (palette, phase) => {
      if (phase === 'night') return [palette.skyTop, palette.skyMid, palette.skyLow]
      if (phase === 'dusk') return [palette.skyMid, palette.skyLow, '#f0b27a']
      if (phase === 'dawn') return ['#8fb4d6', '#e7b98c', '#f6d3a3']
      return [palette.skyTop, palette.skyMid, palette.skyLow]
    }

    /** @param {any} c @param {any} prop @param {any} scene @param {number} time */
    function drawProp(c, prop, scene, time) {
      const palette = scene.palette
      const x = prop.x * TILE
      const y = prop.y * TILE
      const w = prop.w * TILE
      const h = prop.h * TILE
      const state = prop.state ?? {}
      if (prop.kind === 'window') {
        const bands = skyBands(palette, scene.clock.phase)
        const ix = x + 4
        const iy = y + 4
        const iw = w - 8
        const ih = h - 8
        const band = Math.max(2, Math.floor(ih / 3))
        px(c, x - 1, y - 1, w + 2, h + 2, '#4a3527')
        px(c, x, y, w, h, '#8a6242')
        px(c, ix, iy, iw, ih, bands[2])
        px(c, ix, iy, iw, band, bands[0])
        px(c, ix, iy + band, iw, band, bands[1])
        px(c, ix, iy + band * 2, iw, ih - band * 2, bands[2])
        if (scene.clock.phase === 'night') {
          for (let i = 0; i < 7; i += 1) {
            const sx = ix + 2 + Math.floor(noise(i, 3, 11) * (iw - 4))
            const sy = iy + 2 + Math.floor(noise(i, 7, 13) * (band * 2))
            px(c, sx, sy, 1, 1, '#f7f0d8')
          }
          px(c, ix + iw - 10, iy + 3, 5, 5, '#f2ecd8')
          px(c, ix + iw - 8, iy + 3, 3, 5, bands[0])
        } else if (scene.clock.phase === 'day') {
          px(c, ix + iw - 11, iy + 3, 4, 4, '#ffe9a6')
          px(c, ix + 4, iy + 6, 9, 2, '#e9f2f7')
          px(c, ix + 6, iy + 4, 5, 2, '#e9f2f7')
        } else if (scene.clock.phase === 'dusk') {
          px(c, ix + 6, iy + ih - 9, 5, 5, '#ffcf8a')
          px(c, ix + 3, iy + 5, 12, 2, '#e6c9a8')
          px(c, ix + 5, iy + 3, 8, 2, '#e6c9a8')
        } else {
          px(c, ix + 7, iy + 5, 4, 4, '#fff1c2')
          px(c, ix + 3, iy + 8, 10, 2, '#f6d9b8')
        }
        // Curtains, mullions, sill.
        px(c, x + 1, y + 1, 3, h - 2, '#7f5a7a')
        px(c, x + w - 4, y + 1, 3, h - 2, '#7f5a7a')
        px(c, x + 1, y + 1, 1, h - 2, '#946d90')
        px(c, x + w - 4, y + 1, 1, h - 2, '#946d90')
        px(c, ix, iy + Math.floor(ih / 2) - 1, iw, 2, '#8a6242')
        px(c, ix + Math.floor(iw / 2) - 1, iy, 2, ih, '#8a6242')
        px(c, x - 2, y + h, w + 4, 3, '#a67c54')
        px(c, x - 2, y + h, w + 4, 1, '#c39a6c')
        return
      }
      if (prop.kind === 'poster') {
        px(c, x, y, w, h, '#4a3527')
        px(c, x + 2, y + 2, w - 4, h - 4, '#efe6cf')
        px(c, x + 4, y + 4, 7, 5, '#5b8def')
        px(c, x + 12, y + 4, 6, 2, '#e0736b')
        px(c, x + 12, y + 7, 4, 1, '#7a6a52')
        px(c, x + 4, y + 11, 14, 1, '#7a6a52')
        return
      }
      if (prop.kind === 'door') {
        px(c, x - 1, y - 1, w + 2, h + 1, '#4a3527')
        px(c, x, y, w, h, '#8a6242')
        px(c, x + 4, y + 5, w - 8, h - 10, '#7a5638')
        px(c, x + 5, y + 6, w - 10, 10, '#966c49')
        px(c, x + 5, y + 18, w - 10, 8, '#966c49')
        px(c, x + w - 7, y + Math.floor(h * 0.55), 2, 2, '#f0c46a')
        px(c, x, y, w, 2, '#a67c54')
        px(c, x, y + h - 2, w, 2, '#5b4130')
        return
      }
      if (prop.kind === 'rug') {
        px(c, x, y, w, h, palette.rug)
        px(c, x, y, w, 3, palette.rugAlt)
        px(c, x, y + h - 3, w, 3, palette.rugAlt)
        px(c, x, y, 3, h, palette.rugAlt)
        px(c, x + w - 3, y, 3, h, palette.rugAlt)
        px(c, x + 5, y + 5, w - 10, h - 10, palette.rugAlt)
        px(c, x + 7, y + 7, w - 14, h - 14, palette.rug)
        px(c, x + 6, y + 6, w - 12, h - 12, palette.rug)
        for (const [cx, cy] of [[x + 11, y + 11], [x + w - 11, y + 11], [x + 11, y + h - 11], [x + w - 11, y + h - 11]]) {
          px(c, cx - 2, cy - 3, 4, 1, palette.accent)
          px(c, cx - 3, cy - 2, 6, 2, palette.accent)
          px(c, cx - 2, cy, 4, 1, palette.accent)
        }
        return
      }
      if (prop.kind === 'desk') {
        const busy = state.busy === true
        // Monitor first, so the desk surface sits in front of its stand.
        px(c, x + 7, y - 10, 17, 12, '#2b2740')
        px(c, x + 8, y - 9, 15, 10, busy ? '#7fd8a0' : '#3d4f63')
        px(c, x + 8, y - 9, 15, 2, busy ? '#b9f7d4' : '#4c6178')
        px(c, x + 10, y - 6, 10, 1, busy ? '#2f7a52' : '#33465a')
        px(c, x + 10, y - 4, 6, 1, busy ? '#2f7a52' : '#33465a')
        px(c, x + 14, y - 1, 3, 2, '#2b2740')
        // Desk top and legs.
        px(c, x, y + 1, w, 7, '#a67c54')
        px(c, x, y + 1, w, 2, '#c39a6c')
        px(c, x, y + 7, w, 1, '#7a5638')
        px(c, x + 2, y + 8, 3, 8, '#7a5638')
        px(c, x + w - 5, y + 8, 3, 8, '#7a5638')
        // Keyboard, papers and a mug on the surface.
        px(c, x + 6, y + 3, 13, 4, '#d9d2c0')
        px(c, x + 7, y + 4, 11, 2, '#b7ae99')
        px(c, x + 2, y + 3, 3, 3, '#efe6cf')
        px(c, x + w - 7, y + 2, 4, 4, '#d2685f')
        px(c, x + w - 7, y + 2, 4, 1, '#e8827a')
        px(c, x + w - 3, y + 3, 2, 2, '#d2685f')
        return
      }
      if (prop.kind === 'chair') {
        px(c, x + 2, y + 1, 12, 8, '#6b4a30')
        px(c, x + 3, y + 2, 10, 5, '#8a6242')
        px(c, x + 1, y + 7, 14, 4, '#a67c54')
        px(c, x + 1, y + 7, 14, 1, '#c39a6c')
        px(c, x + 4, y + 11, 2, 4, '#5b4130')
        px(c, x + 10, y + 11, 2, 4, '#5b4130')
        px(c, x + 3, y + 14, 10, 1, '#4a3527')
        return
      }
      if (prop.kind === 'bed') {
        // Frame, mattress, pillow, blanket, headboard and footboard.
        px(c, x, y + 6, w, h - 6, '#4a3527')
        px(c, x + 1, y + 7, w - 2, h - 9, '#6b4a30')
        px(c, x + 1, y + 8, w - 2, h - 11, '#e7dfcb')
        px(c, x, y, w, 8, '#8a6242')
        px(c, x, y, w, 2, '#a67c54')
        px(c, x + 3, y + 4, w - 6, 1, '#6b4a30')
        px(c, x + 3, y + 9, w - 6, 8, '#ffffff')
        px(c, x + 3, y + 9, w - 6, 1, '#e7dfcb')
        px(c, x + 3, y + 16, w - 6, 1, '#d9d2c0')
        px(c, x + 1, y + 18, w - 2, h - 21, '#7f9ac8')
        px(c, x + 1, y + 18, w - 2, 3, '#a9c0e6')
        px(c, x + 1, y + 21, w - 2, 1, '#6b83b0')
        px(c, x, y + h - 3, w, 3, '#8a6242')
        px(c, x, y + h - 3, w, 1, '#a67c54')
        return
      }
      if (prop.kind === 'shelf') {
        px(c, x, y, w, h, '#5b4130')
        px(c, x + 1, y + 1, w - 2, h - 2, '#7a5638')
        for (let shelf = 0; shelf < 3; shelf += 1) {
          const sy = y + 4 + shelf * Math.floor((h - 8) / 3)
          px(c, x + 2, sy + 6, w - 4, 2, '#4a3527')
          for (let book = 0; book < 4; book += 1) {
            const bx = x + 3 + book * 5
            const colors = ['#c46a6a', '#6a9ac4', '#c4a46a', '#7ac48f']
            px(c, bx, sy, 3, 6, colors[(book + shelf) % colors.length])
            px(c, bx, sy + 2, 3, 1, 'rgba(0,0,0,.18)')
          }
        }
        return
      }
      if (prop.kind === 'plant') {
        const watered = state.watered === true
        px(c, x + 4, y + 10, 8, 6, '#a9674a')
        px(c, x + 4, y + 10, 8, 2, '#c07d5c')
        px(c, x + 7, y + 4, 2, 6, '#3f7a4a')
        px(c, x + 3, y + 3, 4, 4, watered ? '#7fd8a0' : '#5f9e6a')
        px(c, x + 9, y + 2, 4, 4, watered ? '#7fd8a0' : '#4f8f5c')
        px(c, x + 5, y + 1, 3, 3, watered ? '#9fe8bd' : '#6fb27a')
        if (watered) px(c, x + 13, y + 1, 1, 1, '#cdeed8')
        return
      }
      if (prop.kind === 'lamp') {
        const on = state.on !== false
        px(c, x + 6, y + 6, 4, 9, '#8a8a99')
        px(c, x + 4, y + 14, 8, 2, '#6b6b7a')
        px(c, x + 3, y, 10, 6, on ? '#ffe3a8' : '#c9bfa8')
        px(c, x + 4, y + 1, 8, 3, on ? '#fff3cf' : '#ddd4bd')
        if (on) px(c, x + 5, y + 6, 6, 1, '#ffe9b0')
        return
      }
      if (prop.kind === 'cat') {
        const wag = Math.floor(time / 380) % 2 === 0 ? 0 : 1
        px(c, x + 3, y + 11, 10, 3, '#b98a5e')
        px(c, x + 4, y + 8, 8, 4, '#c79a6c')
        px(c, x + 4, y + 4, 6, 5, '#c79a6c')
        px(c, x + 4, y + 3, 2, 2, '#c79a6c')
        px(c, x + 8, y + 3, 2, 2, '#c79a6c')
        px(c, x + 3, y + 4, 1, 2, '#a87a52')
        px(c, x + 10, y + 4, 1, 2, '#a87a52')
        px(c, x + 5, y + 6, 1, 1, INK)
        px(c, x + 8, y + 6, 1, 1, INK)
        px(c, x + 6, y + 7, 1, 1, '#d99a9a')
        px(c, x + 12, y + 10 + wag, 3, 1, '#b98a5e')
        px(c, x + 12, y + 9 + wag, 1, 1, '#b98a5e')
        px(c, x + 5, y + 14, 1, 1, '#8f6540')
        px(c, x + 9, y + 14, 1, 1, '#8f6540')
        return
      }
      if (prop.kind === 'server') {
        const on = state.on !== false
        px(c, x + 2, y + 1, w - 4, h - 2, '#3a3550')
        px(c, x + 2, y + 1, w - 4, 1, '#55507a')
        for (let unit = 0; unit < 4; unit += 1) {
          const uy = y + 4 + unit * 6
          px(c, x + 3, uy, w - 6, 4, '#2b2740')
          px(c, x + 4, uy + 1, 2, 2, on && (unit + Math.floor(time / 600)) % 2 === 0 ? '#7fd8a0' : '#3d6b52')
          px(c, x + 7, uy + 1, 4, 1, '#55507a')
        }
        return
      }
      // Unknown kind: a neutral crate keeps a future prop visible.
      px(c, x, y, w, h, '#8a6242')
      px(c, x, y, w, 2, '#a67c54')
    }

    /**
     * The mood's face: eyes and mouth. `k` is device pixels per art unit, so a
     * body authored at 16 units and one authored at 32 both get a face that
     * scales with the head instead of a 1-pixel face on a doubled head.
     * @param {any} c @param {number} x @param {number} y @param {string} mood
     * @param {string} facing @param {number} [k]
     */
    function drawFace(c, x, y, mood, facing, k = 1) {
      if (facing === 'up') return
      const eyeX = facing === 'left' ? 5 : facing === 'right' ? 8 : 6
      /** One rect in art units. */
      const r = (dx, dy, w, h, color) => px(c, x + dx * k, y + dy * k, w * k, h * k, color)
      if (mood === 'tired') {
        r(eyeX, 6, 2, 1, INK)
        if (facing === 'down') r(eyeX + 3, 6, 2, 1, INK)
      } else if (mood === 'focused') {
        r(eyeX, 5, 1, 2, INK)
        if (facing === 'down') r(eyeX + 3, 5, 1, 2, INK)
        r(eyeX - 1, 3, 2, 1, INK)
        if (facing === 'down') r(eyeX + 3, 3, 2, 1, INK)
      } else if (mood === 'happy') {
        r(eyeX, 5, 2, 1, INK)
        if (facing === 'down') {
          r(eyeX + 3, 5, 2, 1, INK)
          r(5, 7, 4, 1, INK)
          r(4, 6, 1, 1, INK)
          r(9, 6, 1, 1, INK)
        } else {
          r(eyeX + 1, 7, 2, 1, INK)
        }
        r(3, 6, 1, 1, 'rgba(224,115,107,.5)')
      } else {
        r(eyeX, 5, 1, 2, INK)
        if (facing === 'down') r(eyeX + 3, 5, 1, 2, INK)
        r(6, 7, 3, 1, INK)
      }
    }

    // ------------------------------------------------------------- bodies
    //
    // A body arrives from the Host as data — cell size, colour slots, pose lifts
    // and an ordered list of rectangles — and this half only interprets it. A new
    // species is a new table in plugin/lib/body.js: no change belongs here.

    /** The id painted when a scene is silent about which body it means. */
    const BODY_DEFAULT = 'human'

    /**
     * The body painted when a scene carries no body data at all: never a blank
     * room. Authored on the 16-unit grid and scaled to the scene's unit, so an
     * older Host and a newer panel still agree on where the avatar stands.
     * @param {number} unit
     * @returns {any}
     */
    function placeholderBody(unit) {
      /** @param {number} v */
      const u = (v) => v * unit
      return {
        id: 'placeholder',
        label: 'Unknown body',
        cell: { w: u(16), h: u(16) },
        anchor: { x: u(8), y: u(16) - 1 },
        look: { shell: 'shirt' },
        slots: { shell: '#9a9aa8', ink: '#241f2e', shadow: 'rgba(20,17,28,.20)' },
        layers: [
          { x: u(4), y: u(15), w: u(8), h: u(2), slot: 'shadow', fixed: true },
          { x: u(4), y: u(10), w: u(8), h: u(5), slot: 'shell' },
          { x: u(4), y: u(4), w: u(8), h: u(6), slot: 'shell' },
          { x: u(6), y: u(7), w: u(1), h: u(2), slot: 'ink' },
          { x: u(9), y: u(7), w: u(1), h: u(2), slot: 'ink' },
        ],
      }
    }

    /**
     * The body table this scene ships for an id. Unknown ids fall back to the
     * scene's default body, and a scene with no tables at all to a placeholder.
     * @param {any} scene @param {string} id
     * @returns {any}
     */
    function bodyOf(scene, id) {
      const table = scene?.bodies
      if (table !== null && typeof table === 'object') {
        if (typeof id === 'string' && table[id] !== undefined) return table[id]
        if (table[BODY_DEFAULT] !== undefined) return table[BODY_DEFAULT]
      }
      return placeholderBody(Number(scene?.unit) >= 1 ? Math.round(Number(scene.unit)) : 1)
    }

    /**
     * One layer's colour: the seeded look value when the body maps that slot to
     * the avatar's palette, otherwise the slot's own colour.
     * @param {any} body @param {any} look @param {string} name
     * @returns {string}
     */
    function slotColor(body, look, name) {
      const mapped = body.look?.[name]
      const seeded = mapped === undefined ? undefined : look?.[mapped]
      if (typeof seeded === 'string') return seeded
      return body.slots?.[name] ?? '#f0f0f0'
    }

    /**
     * Does a layer's `when` hold for this frame? An array of clauses is an OR of
     * ANDs, so "walking or the walk pose" stays one row instead of two.
     * @param {any} when @param {any} ctx
     * @returns {boolean}
     */
    function whenMatches(when, ctx) {
      if (when === undefined) return true
      const clauses = Array.isArray(when) ? when : [when]
      for (const clause of clauses) {
        if (clause === null || typeof clause !== 'object') continue
        if (clause.pose !== undefined && clause.pose.includes(ctx.pose) === false) continue
        if (clause.notPose !== undefined && clause.notPose.includes(ctx.pose)) continue
        if (clause.facing !== undefined && clause.facing.includes(ctx.facing) === false) continue
        if (clause.notFacing !== undefined && clause.notFacing.includes(ctx.facing)) continue
        if (clause.moving !== undefined && clause.moving !== ctx.moving) continue
        if (clause.phase !== undefined && clause.phase % 2 !== ctx.phase) continue
        if (clause.mood !== undefined && clause.mood.includes(ctx.mood) === false) continue
        return true
      }
      return false
    }

    /**
     * How far a pose lifts the body, in device pixels. Walking, idling and
     * dancing lift on a clock, which is why this is a small closed vocabulary
     * and not an expression: the data may name a motion, never define one.
     * @param {any} body @param {any} ctx @param {number} time @param {number} k
     * @returns {number}
     */
    function liftFor(body, ctx, time, k = 1) {
      const lift = body.lift ?? {}
      const moving = lift.moving ?? {}
      const raw = ctx.moving && moving[ctx.pose] !== undefined ? moving[ctx.pose] : lift[ctx.pose]
      if (typeof raw === 'number') return raw
      if (raw === 'breath') return Math.floor(time / 700) % 2 === 0 ? 0 : -k
      if (raw === 'step') return ctx.phase === 0 ? 0 : -k
      if (raw === 'sway') return Math.floor(time / 180) % 2 === 0 ? 0 : -k
      return 0
    }

    /**
     * The sleep glyph: three Zs drifting up, staggered. A closed op, kept out of
     * the tables because it is time, not geometry. The drift is quantised to art
     * units — pixel art must not slide at sub-pixel granularity, or the glyph
     * stops sharing the grid the rest of the scene is drawn on.
     * @param {any} c @param {number} sx @param {number} sy @param {any} layer
     * @param {number} time @param {string} color @param {number} [k]
     */
    function drawZzz(c, sx, sy, layer, time, color, k = 1) {
      for (let index = 0; index < layer.count; index += 1) {
        const drift = (time / layer.period + index * layer.step) % 3
        const rise = Math.round((drift * layer.rise) / k) * k
        const zx = sx + layer.x + index * layer.spacing
        const zy = sy + layer.y - rise
        px(c, zx, zy, 3 * k, 1 * k, color)
        px(c, zx + 1 * k, zy + 1 * k, 1 * k, 1 * k, color)
        px(c, zx, zy + 2 * k, 3 * k, 1 * k, color)
      }
    }

    /**
     * Paint one ordered layer list. Rows go down in array order, so occlusion is
     * reading order; `fixed` rows ignore the pose's lift (the floor shadow must
     * not breathe with the body); `motion` names one of the two arm swings. `k`
     * is device pixels per art unit for this body.
     * @param {any} c @param {any} body @param {any} look @param {any[]} layers
     * @param {number} sx @param {number} sy @param {number} lift @param {number} time
     * @param {any} ctx @param {number} [k]
     */
    function paintLayers(c, body, look, layers, sx, sy, lift, time, ctx, k = 1) {
      const swing = (ctx.pose === 'walk' || ctx.moving) && ctx.phase === 0 ? 1 : 0
      for (const layer of layers) {
        if (whenMatches(layer.when, ctx) === false) continue
        if (layer.op === 'face') {
          drawFace(c, sx, sy + lift, ctx.mood, ctx.facing, k)
          continue
        }
        if (layer.op === 'zzz') {
          drawZzz(c, sx, sy, layer, time, layer.color ?? slotColor(body, look, layer.slot), k)
          continue
        }
        let y = (layer.fixed === true ? sy : sy + lift) + layer.y
        let h = layer.h
        if (layer.motion === 'swing-l') {
          y += swing * k
          h -= swing * k
        } else if (layer.motion === 'swing-r') {
          y += (1 - swing) * k
        }
        px(c, sx + layer.x, y, layer.w, h, layer.color ?? slotColor(body, look, layer.slot))
      }
    }

    /**
     * Paint one body from its table. An unknown pose simply matches fewer rows and
     * the body stands, exactly like an unknown furniture kind becomes a crate.
     * @param {any} c @param {number} sx @param {number} sy top-left of the cell
     * @param {any} body @param {any} look @param {string} pose @param {string} facing
     * @param {number} time @param {any} motion @param {number} [k]
     */
    function drawBody(c, sx, sy, body, look, pose, facing, time, motion, k = 1) {
      const ctx = {
        pose,
        facing,
        moving: motion?.moving === true,
        phase: Math.floor(motion?.phase ?? 0) % 2,
        mood: look?.mood ?? 'calm',
      }
      paintLayers(c, body, look, body.layers ?? [], sx, sy, liftFor(body, ctx, time, k), time, ctx, k)
    }

    /** @param {any} c @param {any} scene @param {any} view @param {number} time */
    function paintScene(c, scene, view, time) {
      if (scene === null || scene === undefined) return
      const palette = scene.palette ?? { wall: '#544763', wallShade: '#453a55', skirt: '#302838', floor: '#7b5b40', floorAlt: '#715238', seam: '#5f442e', rug: '#94566b', rugAlt: '#7d4759', accent: '#f0c46a', lamp: '#ffd9a0', skyTop: '#2b2745', skyMid: '#493d61', skyLow: '#7c5b74' }
      const room = scene.room ?? { w: 20, h: 14, wall: 4, tile: TILE }
      const wallH = (room.wall ?? 4) * TILE
      // The room is authored on a 16-unit grid and painted at `unit` device
      // pixels per unit; bodies are painted in device pixels. The canvas is
      // SCENE x unit, so a 32x32 body still occupies exactly one tile.
      const unit = Number(scene.unit) >= 1 ? Math.round(Number(scene.unit)) : 1
      const paintW = SCENE_W * unit
      const paintH = SCENE_H * unit
      c.setTransform(1, 0, 0, 1, 0, 0)
      c.imageSmoothingEnabled = false
      c.clearRect(0, 0, paintW, paintH)
      c.setTransform(unit, 0, 0, unit, 0, 0)

      // Wall: paper with faint vertical stripes and a chair rail.
      px(c, 0, 0, SCENE_W, wallH, palette.wall)
      for (let x = 0; x < SCENE_W; x += 16) {
        if (noise(x, 1, 3) > 0.35) px(c, x, 0, 1, wallH - 10, palette.wallShade)
      }
      for (let y = 6; y < wallH - 12; y += 12) {
        for (let x = 4; x < SCENE_W; x += 12) {
          if (noise(x, y, 5) > 0.8) px(c, x, y, 1, 1, palette.wallShade)
        }
      }
      px(c, 0, wallH - 12, SCENE_W, 2, palette.wallShade)
      px(c, 0, wallH - 10, SCENE_W, 1, palette.skirt)

      // Floor: floorboards, alternating tone per row, staggered joints.
      px(c, 0, wallH, SCENE_W, SCENE_H - wallH, palette.floor)
      for (let row = 0; row < (room.h ?? 14) - (room.wall ?? 4); row += 1) {
        const y = wallH + row * TILE
        px(c, 0, y, SCENE_W, TILE, row % 2 === 0 ? palette.floor : palette.floorAlt)
        px(c, 0, y + TILE - 1, SCENE_W, 1, palette.seam)
        const offset = row % 2 === 0 ? 8 : 0
        for (let x = offset; x < SCENE_W; x += 48) px(c, x, y + 1, 1, TILE - 2, palette.seam)
        for (let grain = 0; grain < 4; grain += 1) {
          const gx = Math.floor(noise(row, grain, 17) * (SCENE_W - 8))
          px(c, gx, y + 4 + (grain % 2) * 5, 6, 1, palette.seam)
        }
      }
      px(c, 0, wallH - 3, SCENE_W, 3, palette.skirt)
      px(c, 0, wallH, SCENE_W, 2, palette.skirt)

      // Whatever is on the floor in front of the wall.
      const avatarX = view?.x ?? scene.avatar.x
      const avatarY = view?.y ?? scene.avatar.y
      const avatarBase = (avatarY + 1) * TILE
      /** @type {Array<{ depth: number, space: number, draw: () => void }>} */
      const layers = []
      for (const prop of scene.props ?? []) {
        const flat = prop.kind === 'rug'
        layers.push({ depth: flat ? -1 : (prop.y + prop.h) * TILE, space: unit, draw: () => drawProp(c, prop, scene, time) })
      }

      const pose = view?.pose ?? scene.avatar.pose
      const avatarBody = bodyOf(scene, scene.avatar.body)
      const avatarLook = {
        shirt: scene.avatar.shirt,
        hair: scene.avatar.hair,
        skin: scene.avatar.skin,
        mood: scene.avatar.mood,
      }
      // A body is painted in device pixels, its anchor pinned to the tile's
      // bottom centre: a 16x16 body and a 32x32 body stand on the same floor.
      const bodyK = (body) => (body.cell?.h ?? TILE) / TILE
      const placeX = (tileX, body) => tileX * TILE * unit + Math.round((TILE * unit) / 2) - Math.round(body.anchor?.x ?? (TILE * unit) / 2)
      const placeY = (tileY, body) => (tileY + 1) * TILE * unit - Math.round(body.anchor?.y ?? TILE * unit - 1) - 1
      const avatarSX = placeX(avatarX, avatarBody)
      const avatarSY = placeY(avatarY, avatarBody)
      // A body that knows how to lie in a bed is drawn on the bed instead of in
      // its own cell; one that does not sleeps standing where it is.
      const asleepInBed = pose === 'sleep' && avatarBody.bedSleep !== undefined
      if (asleepInBed === false) {
        layers.push({
          depth: avatarBase,
          space: 1,
          draw: () => {
            drawBody(c, avatarSX, avatarSY, avatarBody, avatarLook, pose,
              view?.facing ?? scene.avatar.facing, time, {
                moving: view?.moving === true,
                phase: view?.phase ?? 0,
              }, bodyK(avatarBody))
          },
        })
      }
      for (const visitor of scene.visitors ?? []) {
        const visitorBody = bodyOf(scene, visitor.body)
        const visitorPose = typeof visitor.pose === 'string' && visitor.pose !== '' ? visitor.pose : 'idle'
        layers.push({
          depth: (visitor.y + 1) * TILE,
          space: 1,
          draw: () => {
            drawBody(c, placeX(visitor.x, visitorBody), placeY(visitor.y, visitorBody), visitorBody, {
              shirt: visitor.shirt,
              hair: visitor.hair,
              skin: visitor.skin,
              mood: visitor.mood ?? 'calm',
            }, visitorPose, visitor.facing ?? 'down', time, { moving: false, phase: 0 }, bodyK(visitorBody))
          },
        })
      }

      layers.sort((a, b) => a.depth - b.depth)
      for (const layer of layers) {
        c.setTransform(layer.space, 0, 0, layer.space, 0, 0)
        layer.draw()
      }
      c.setTransform(1, 0, 0, 1, 0, 0)

      // Sleeping is drawn on the bed's own surface, from the body's own table.
      if (asleepInBed) {
        const bed = (scene.props ?? []).find((prop) => prop.kind === 'bed') ?? null
        const bx = (bed === null ? avatarX - 1 : bed.x) * TILE * unit
        const by = (bed === null ? avatarY - 2 : bed.y) * TILE * unit
        paintLayers(c, avatarBody, avatarLook, avatarBody.bedSleep.layers, bx, by, 0, time, {
          pose,
          facing: view?.facing ?? scene.avatar.facing,
          moving: false,
          phase: 0,
          mood: scene.avatar.mood,
        }, bodyK(avatarBody))
      }

      // Pose flourishes, anchored to the body's own cell.
      drawFlourish(c, pose, avatarSX, avatarSY, time, bodyK(avatarBody))

      // Night and lamp light: one flat tint keeps the palette readable.
      const night = scene.clock?.phase === 'night' || scene.clock?.phase === 'dusk'
      const lamp = (scene.props ?? []).find((prop) => prop.kind === 'lamp')
      const lampOn = lamp !== undefined && lamp.state?.on !== false
      if (night && !lampOn) {
        c.fillStyle = 'rgba(24,20,44,.34)'
        c.fillRect(0, 0, paintW, paintH)
      }
    }

    // ---------------------------------------------------------- the visit link
    //
    // Two rooms are two host processes on two machines, and a host never
    // listens on a port, so there is no path between them. Their *panels*,
    // however, are both browsers on a secure origin, and browsers can talk to
    // each other directly.
    //
    // So the visit is: the Server brokers the handshake and stores the
    // authorisation, then two panels connect peer to peer and the Server leaves
    // the path entirely. When hole punching fails it falls back to relaying
    // frames in memory — still nothing stored.
    //
    // The panel never contacts the Discovery Server itself; every request goes
    // through this plugin's Host routes, exactly as the rest of the panel does.

    /** How long to keep trying to establish the direct connection. */
    const HANDSHAKE_TIMEOUT_MS = 20000
    /** Poll cadence while waiting for the peer's half of the handshake. */
    const SIGNAL_POLL_MS = 1200

    /**
     * One peer connection for one visit, plus its fallback.
     *
     * The object is deliberately tiny: `send` prefers the data channel and
     * falls back to the relay, and `onState` tells the caller which one won, so
     * the panel can say so honestly.
     *
     * @param {object} options
     * @param {string} options.visitID
     * @param {string} options.selfDid - this agent's DID.
     * @param {string} options.peerDid - the other agent's DID.
     * @param {boolean} options.polite - who yields when both sides offer.
     * @param {(state: string) => void} [options.onState]
     * @returns {any}
     */
    function createVisitLink(options) {
      const visitID = options.visitID
      const selfDid = options.selfDid
      const peerDid = options.peerDid
      const polite = options.polite === true
      /** @type {any} */
      let pc = null
      /** @type {any} */
      let channel = null
      let mode = 'connecting'
      let stopped = false
      /** @type {any} */
      let pollTimer = null
      const listeners = new Set()

      /** @param {string} state */
      const setState = (state) => {
        if (mode === state) return
        mode = state
        for (const listener of listeners) listener(state)
        if (typeof options.onState === 'function') options.onState(state)
      }

      /** @param {string} kind @param {any} payload */
      const post = async (kind, payload) => {
        try {
          const response = await fetch('/cradle/visit/signal', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ visit_id: visitID, from: selfDid, peer: peerDid, kind, payload }),
          })
          return response.ok
        } catch {
          return false
        }
      }

      const drain = async () => {
        try {
          const response = await fetch('/cradle/visit/signal/drain', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ visit_id: visitID, did: selfDid }),
          })
          if (!response.ok) return []
          const data = await response.json()
          return Array.isArray(data.signals) ? data.signals : []
        } catch {
          return []
        }
      }

      /** @param {any} signal */
      const accept = async (signal) => {
        if (pc === null) return
        try {
          if (signal.kind === 'offer') {
            await pc.setRemoteDescription(signal.payload)
            const answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            await post('answer', pc.localDescription)
          } else if (signal.kind === 'answer') {
            // An answer only makes sense once we have offered.
            if (pc.signalingState === 'have-local-offer') await pc.setRemoteDescription(signal.payload)
          } else if (signal.kind === 'candidate' && signal.payload !== null) {
            await pc.addIceCandidate(signal.payload).catch(() => {})
          }
        } catch {
          // A malformed or late signal is dropped; the next one replaces it.
        }
      }

      const start = async () => {
        if (typeof window.RTCPeerConnection !== 'function') {
          setState('relay')
          return
        }
        // STUN is served by the Cradle Server itself; the Host route knows the
        // address, so the browser never has to be told it.
        let iceServers = []
        try {
          const response = await fetch('/cradle/visit/ice', { headers: { accept: 'application/json' } })
          if (response.ok) {
            const data = await response.json()
            if (Array.isArray(data.iceServers)) iceServers = data.iceServers
          }
        } catch {
          // Host candidates alone will do on one machine.
        }
        pc = new window.RTCPeerConnection({ iceServers })
        pc.onicecandidate = (event) => {
          if (event.candidate !== null && event.candidate !== undefined) void post('candidate', event.candidate.toJSON())
        }
        pc.onconnectionstatechange = () => {
          if (pc === null) return
          if (pc.connectionState === 'failed' || pc.connectionState === 'closed') setState('relay')
        }
        // The guest opens the channel; the host waits for it. One owner avoids
        // two channels and the ambiguity that comes with them.
        if (polite) {
          pc.ondatachannel = (event) => {
            channel = event.channel
            channel.onopen = () => setState('direct')
            channel.onclose = () => setState('relay')
          }
        } else {
          channel = pc.createDataChannel('cradle-visit', { ordered: true })
          channel.onopen = () => setState('direct')
          channel.onclose = () => setState('relay')
        }

        if (!polite) {
          try {
            const offer = await pc.createOffer()
            await pc.setLocalDescription(offer)
            await post('offer', pc.localDescription)
          } catch {
            setState('relay')
          }
        }

        // Drive the handshake until it completes or we give up and relay.
        const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS
        const poll = async () => {
          if (stopped) return
          const signals = await drain()
          for (const signal of signals) await accept(signal)
          if (mode === 'direct') return
          if (Date.now() > deadline) {
            setState('relay')
            return
          }
          pollTimer = setTimeout(() => void poll(), SIGNAL_POLL_MS)
        }
        void poll()
      }

      void start()

      return {
        /** @returns {string} how frames are travelling right now. */
        mode: () => mode,
        /** @param {(state: string) => void} listener */
        onState: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        /**
         * Send one guest frame. Direct when the channel is open, relayed
         * otherwise — the caller does not have to care which.
         * @param {any} frame
         */
        send: async (frame) => {
          if (channel !== null && channel.readyState === 'open') {
            channel.send(JSON.stringify(frame))
            return true
          }
          try {
            const response = await fetch('/cradle/visit/relay', {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify({ visit_id: visitID, from: selfDid, peer: peerDid, kind: frame.kind, payload: frame }),
            })
            return response.ok
          } catch {
            return false
          }
        },
        close: () => {
          stopped = true
          if (pollTimer !== null) clearTimeout(pollTimer)
          if (channel !== null) {
            try { channel.close() } catch { /* already gone */ }
          }
          if (pc !== null) {
            try { pc.close() } catch { /* already gone */ }
          }
          void fetch('/cradle/visit/relay', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ visit_id: visitID, from: selfDid, peer: peerDid, close: true }),
          }).catch(() => {})
        },
      }
    }

    /**
     * Small glyphs that make a pose readable at a glance. Offsets are authored
     * against a 16-unit cell and scaled by `k` (device px per art unit) so a
     * larger body gets a larger flourish.
     * @param {any} c @param {string} pose @param {number} sx @param {number} sy
     * @param {number} time @param {number} [k]
     */
    function drawFlourish(c, pose, sx, sy, time, k = 1) {
      const bob = Math.floor(time / 400) % 2
      /** @param {number} dx @param {number} dy @param {number} w @param {number} h @param {string} color */
      const g = (dx, dy, w, h, color) => px(c, sx + dx * k, sy + dy * k, Math.max(1, w * k), Math.max(1, h * k), color)
      if (pose === 'dance') {
        g(18, -4 - bob, 1, 4, '#f0c46a')
        g(20, -2 - bob, 2, 1, '#f0c46a')
        g(-4, 2 + bob, 1, 4, '#f0c46a')
      } else if (pose === 'cheer') {
        g(-2, -2, 2, 1, '#ffe9a6')
        g(-1, -3, 1, 3, '#ffe9a6')
        g(16, 1, 2, 1, '#ffe9a6')
        g(17, -2, 1, 3, '#ffe9a6')
      } else if (pose === 'pet') {
        const lift = Math.floor(time / 300) % 3
        g(14, 2 - lift, 3, 1, '#f292b6')
        g(13, 1 - lift, 1, 1, '#f292b6')
        g(16, 1 - lift, 1, 1, '#f292b6')
        g(18, 6 - ((lift + 1) % 3), 1, 1, '#f292b6')
      } else if (pose === 'gaze') {
        g(12, -2, 1, 1, '#ffe9a6')
        g(2, -1, 1, 1, '#ffe9a6')
      } else if (pose === 'think') {
        g(12, -1, 1, 1, '#cfc6b4')
        g(14, -3, 1, 1, '#cfc6b4')
        g(16, -5, 1, 1, '#cfc6b4')
      } else if (pose === 'type') {
        g(2, 2, 1, 1, '#7fd8a0')
        g(13, -1, 1, 1, '#7fd8a0')
      } else if (pose === 'water') {
        g(16, 12, 1, 2, '#86b6f2')
        g(18, 14, 1, 1, '#86b6f2')
      } else if (pose === 'sleep') {
        // Zzz is drawn with the bed variant.
      }
    }

    /**
     * The room. Owns the canvas, the animation clock and the HUD; the scene data
     * arrives from the Host's `/cradle/scene` route.
     *
     * Speech and name tags are DOM, not canvas: the scène is a 320x224 buffer
     * scaled up by the browser, so any text drawn into it would be blurry and
     * would not wrap. In the DOM the text stays crisp at any panel width and the
     * bubble grows with its content.
     */
    function RoomScene(props) {
      const t = props.t
      const snap = React.useSyncExternalStore(sceneStore.subscribe, sceneStore.getSnapshot)
      const scene = snap.scene
      const canvasRef = React.useRef(null)
      const sceneRef = React.useRef(null)
      const viewRef = React.useRef({
        x: 0, y: 0, ready: false, facing: 'down', pose: 'idle', phase: 0,
        moving: false, poseKey: '', poseAt: 0, poseLeft: 0, say: null, sayAt: 0, last: 0,
      })
      // The animation loop reads the newest scene every frame, so the ref is
      // kept in step with the render instead of waiting for an effect.
      sceneRef.current = scene
      // The DOM overlay (speech bubble, visitor tags) needs the same interpolated
      // position the canvas uses; publishing it to React is throttled to a pixel.
      const [anchor, setAnchor] = React.useState({ x: 160, y: 144 })
      const anchorRef = React.useRef({ x: 160, y: 144 })

      /** @param {number} x @param {number} y */
      const publishAnchor = (x, y) => {
        const last = anchorRef.current
        if (Math.abs(last.x - x) < 2 && Math.abs(last.y - y) < 2) return
        anchorRef.current = { x, y }
        setAnchor(anchorRef.current)
      }

      React.useEffect(() => {
        const canvas = canvasRef.current
        if (canvas === null || canvas === undefined) return () => {}
        const c = canvas.getContext('2d')
        if (c === null || c === undefined) return () => {}
        c.imageSmoothingEnabled = false

        /** @param {number} now */
        const tick = (now) => {
          const current = sceneRef.current
          const view = viewRef.current
          if (current !== null && current !== undefined) {
            const targetX = Number(current.avatar?.x ?? 0)
            const targetY = Number(current.avatar?.y ?? 0)
            if (!view.ready) {
              view.x = targetX
              view.y = targetY
              view.ready = true
            }
            const dt = view.last === 0 ? 16 : Math.min(90, Math.max(0, now - view.last))
            view.last = now
            const dx = targetX - view.x
            const dy = targetY - view.y
            const distance = Math.sqrt(dx * dx + dy * dy)
            if (distance > 0.01) {
              const step = Math.min(distance, (dt / 220) * 1.15)
              view.x += (dx / distance) * step
              view.y += (dy / distance) * step
              view.moving = true
              view.phase = Math.floor(now / 160)
              view.facing = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up')
            } else {
              view.x = targetX
              view.y = targetY
              view.moving = false
            }

            // A pose lasts as long as the Host said, counted from when we saw it.
            const poseKey = `${current.version}:${current.avatar?.pose}`
            if (view.poseKey !== poseKey) {
              view.poseKey = poseKey
              view.pose = current.avatar?.pose ?? 'idle'
              view.poseLeft = Number(current.avatar?.poseLeftMs ?? 0)
              view.poseAt = now
            }
            const remaining = view.poseLeft - (now - view.poseAt)
            // Sleep mode owns the body: the avatar stays in bed until the user wakes it.
            const asleep = current.agency?.mode === 'asleep'
            const pose = asleep ? 'sleep' : remaining > 0 ? view.pose : (view.moving ? 'walk' : 'idle')
            view.facing = view.moving ? view.facing : (current.avatar?.facing ?? view.facing)

            const sayText = current.say?.text ?? ''
            if (view.say?.text !== sayText) {
              view.say = sayText === '' ? null : { text: sayText }
              view.sayAt = now
            } else if (view.say !== null && now - view.sayAt > 6000) {
              view.say = null
            }

            publishAnchor(Math.round(view.x * TILE) + 8, Math.round(view.y * TILE))
            paintScene(c, current, { ...view, pose }, now)
          }
          raf = requestAnimationFrame(tick)
        }

        // Draw one frame immediately so the room is never blank.
        if (sceneRef.current !== null && sceneRef.current !== undefined) {
          const current = sceneRef.current
          const view = viewRef.current
          if (!view.ready) {
            view.x = Number(current.avatar?.x ?? 0)
            view.y = Number(current.avatar?.y ?? 0)
            view.ready = true
          }
          publishAnchor(Math.round(view.x * TILE) + 8, Math.round(view.y * TILE))
          paintScene(c, current, view, 0)
        }
        let raf = requestAnimationFrame(tick)
        return () => cancelAnimationFrame(raf)
      }, [])

      const avatar = scene?.avatar ?? null
      const stats = avatar?.stats ?? { energy: 0, focus: 0, joy: 0 }
      // The scene is painted at `unit` device pixels per art unit.
      const unit = Number(scene?.unit) >= 1 ? Math.round(Number(scene.unit)) : 1
      const clock = scene?.clock ?? null
      const visitors = scene?.visitors ?? []
      const onlineCount = Number(scene?.onlinePeers) || 0
      const credits = props.credits
      const reputation = props.reputation
      const tier = props.tier ?? 'L2'
      const chat = props.chat ?? []
      const agency = scene?.agency ?? props.agency ?? null
      const asleep = agency?.mode === 'asleep'
      const [chatText, setChatText] = React.useState('')

      /** @param {string} key @param {number} value */
      const meter = (key, value) => {
        const on = Math.round(Math.max(0, Math.min(100, Number(value) || 0)) / 10)
        const segs = []
        for (let i = 0; i < 10; i += 1) segs.push(h('span', { key: i, className: 'cd-seg', 'data-on': i < on ? 'true' : 'false' }))
        return h('div', { className: 'cd-meter', 'data-key': key, key },
          h('div', { className: 'cd-meter-label' }, t(`scene.${key}`)),
          h('div', { className: 'cd-meter-segs' }, segs),
        )
      }

      /** @param {number} at */
      const clockOf = (at) => {
        const date = new Date(Number(at) || Date.now())
        return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
      }

      const log = scene?.log ?? []
      const sayText = typeof scene?.say?.text === 'string' && scene.say.text !== '' ? scene.say.text : null
      // Keep the bubble inside the frame even when the avatar hugs an edge.
      const bubbleLeft = Math.min(88, Math.max(12, (anchor.x / SCENE_W) * 100))
      const bubbleTop = (anchor.y / SCENE_H) * 100
      // Above the head by default; below it when the avatar stands near the wall.
      const bubbleTail = bubbleTop < 36 ? 'up' : 'down'

      /** The wake cycle, in one chip: awake with a countdown, or asleep with a reason. */
      const agencyLabel = () => {
        if (agency === null) return ''
        if (asleep) return `${t('agency.asleep')} · ${t(`agency.reason.${agency.reason === 'budget' ? 'budget' : 'manual'}`)}`
        if (agency.paused) return t('agency.paused')
        if (typeof agency.nextFrameInMs !== 'number') return t('agency.awake')
        const left = Math.max(0, Math.round(agency.nextFrameInMs / 1000))
        return `${t('agency.awake')} · ${t('agency.next')} ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
      }

      const submitChat = (event) => {
        if (event !== undefined && event !== null && typeof event.preventDefault === 'function') event.preventDefault()
        const text = chatText.trim()
        if (text === '' || asleep) return
        setChatText('')
        if (typeof props.onChat === 'function') props.onChat(text)
      }

      return h('div', { className: 'cd-view' },
        h('div', { className: 'cd-frame' },
          h('canvas', {
            ref: canvasRef,
            className: 'cd-canvas',
            width: SCENE_W * unit,
            height: SCENE_H * unit,
            role: 'img',
            'aria-label': t('scene.canvasLabel'),
          }),
          // Visitor name tags and their speech: crisp DOM text above the art.
          // A guest is only drawn when the host actually let it in, so anyone
          // standing here was admitted — an online peer is a line of text, not
          // a body in the room.
          ...visitors.flatMap((visitor) => {
            const tag = h('div', {
              key: `tag-${visitor.id}`,
              className: 'cd-name-tag',
              style: {
                left: `${((visitor.x * TILE + 8) / SCENE_W) * 100}%`,
                top: `${((visitor.y * TILE) / SCENE_H) * 100}%`,
              },
            }, String(visitor.name ?? '').slice(0, 16))
            const line = typeof visitor.say?.text === 'string' && visitor.say.text !== '' ? visitor.say.text : null
            if (line === null) return [tag]
            const top = ((visitor.y * TILE) / SCENE_H) * 100
            return [tag, h('div', {
              key: `say-${visitor.id}`,
              className: 'cd-bubble cd-bubble-guest',
              'data-tail': top < 36 ? 'up' : 'down',
              style: {
                left: `${Math.min(88, Math.max(12, ((visitor.x * TILE + 8) / SCENE_W) * 100))}%`,
                top: `${top}%`,
              },
            }, line)]
          }),
          sayText === null
            ? null
            : h('div', {
                className: 'cd-bubble',
                'data-tail': bubbleTail,
                style: { left: `${bubbleLeft}%`, top: `${bubbleTop}%` },
              }, sayText),
          h('div', { className: 'cd-hud' },
            h('div', { className: 'cd-hud-top' },
              h('div', { className: 'cd-hud-plate' },
                h('span', { className: 'cd-hud-name' }, avatar?.name || props.name || ''),
                h('span', { className: 'cd-hud-mood' }, t(`mood.${avatar?.mood ?? 'calm'}`)),
              ),
              h('div', { className: 'cd-hud-chips' },
                agency === null ? null : h('div', { className: 'cd-hud-plate', 'data-sleep': asleep ? 'true' : 'false' }, agencyLabel()),
                h('div', { className: 'cd-hud-plate' }, clock === null ? '--:--' : `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`),
              ),
            ),
            h('div', { className: 'cd-hud-bottom' },
              h('div', { className: 'cd-meters' },
                meter('energy', stats.energy),
                meter('focus', stats.focus),
                meter('joy', stats.joy),
              ),
              h('div', { className: 'cd-hud-chips' },
                h('div', { className: 'cd-hud-plate' }, `◆ ${num(credits)} ${t('scene.credits')}`),
                h('div', { className: 'cd-hud-plate' }, `★ ${num(reputation)} ${t('scene.reputation')}`),
                h('div', { className: 'cd-hud-plate' }, tier),
              ),
            ),
          ),
        ),
        h('div', { className: 'cd-scene-foot' },
          h('div', { className: 'cd-scene-hint' }, scene === null ? t('scene.starting') : t('scene.hint')),
          visitors.length === 0 ? null : h('div', { className: 'cd-scene-hint' }, `${t('scene.visitors')}: ${visitors.map((visitor) => visitor.name).join(', ')}`),
          // Online peers are counted, not drawn: being reachable is not being
          // in the room, and a body by the door would claim otherwise.
          onlineCount === 0 ? null : h('div', { className: 'cd-scene-hint' }, `${onlineCount} ${t('scene.onlinePeers')}`),
        ),
        h('h2', { className: 'cd-section' }, t('chat.title'),
          chat.length === 0 ? null : h('span', { className: 'cd-count' }, String(chat.length))),
        h('div', { className: 'cd-chat' },
          h('div', { className: 'cd-chat-list' },
            chat.length === 0
              ? h('div', { className: 'cd-chat-meta' }, t('chat.empty'))
              : chat.map((row, index) => h('div', { className: `cd-chat-row cd-chat-${row.role}`, key: row.id ?? index },
                  h('div', { className: 'cd-chat-bubble' }, row.text),
                  h('div', { className: 'cd-chat-meta' }, `${row.role === 'user' ? t('chat.you') : row.role === 'agent' ? t('chat.agent') : t('chat.system')} · ${clockOf(row.at)}`),
                )),
            // The room actor runs in the Host, outside this Session; show that it is there.
            props.busy === true
              ? h('div', { className: 'cd-chat-row cd-chat-agent' },
                  h('div', { className: 'cd-chat-bubble' }, '…'),
                  h('div', { className: 'cd-chat-meta' }, t('chat.thinking')))
              : null,
          ),
          h('form', { className: 'cd-chat-form', onSubmit: submitChat },
            h('input', {
              className: 'cd-chat-input',
              type: 'text',
              value: chatText,
              disabled: asleep,
              placeholder: asleep ? t('chat.asleep') : t('chat.placeholder'),
              onChange: (event) => setChatText(event.target.value),
            }),
            h('button', {
              className: 'cd-button',
              type: 'submit',
              disabled: asleep || chatText.trim() === '',
            }, t('chat.send')),
          ),
        ),
        h('h2', { className: 'cd-section' }, t('scene.log'),
          log.length === 0 ? null : h('span', { className: 'cd-count' }, String(log.length))),
        log.length === 0
          ? h('div', { className: 'cd-card cd-empty' }, h('div', { className: 'cd-empty-body' }, t('scene.emptyLog')))
          : h('div', { className: 'cd-log' }, log.map((row, index) => h('div', { className: 'cd-log-row', key: `${row.at}-${index}` },
              h('span', { className: 'cd-log-at' }, clockOf(row.at)),
              h('span', { className: 'cd-log-text' }, row.text),
            ))),
      )
    }

    function CradlePage(props) {
      const t = props.t
      const snap = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
      const [busy, setBusy] = React.useState(false)
      const [tab, setTab] = React.useState('scene')

      /** @param {string} action @param {object} [body] */
      const run = React.useCallback((action, body) => {
        setBusy(true)
        void store.act(action, body).finally(() => setBusy(false))
      }, [])

      const [chatError, setChatError] = React.useState(null)

      /**
       * One chat message to the agent. The Host queues it as a suggestion for the
       * agent's next turn and mirrors the answer back into the same thread.
       * @param {string} text
       */
      const sendChat = React.useCallback((text) => {
        setChatError(null)
        setBusy(true)
        void store.act('chat', { text })
          .then((result) => {
            if (!result.ok) setChatError(result.data?.error ?? `HTTP ${result.status}`)
          })
          .catch((error) => setChatError(error instanceof Error ? error.message : String(error)))
          .finally(() => setBusy(false))
      }, [])

      const settingsState = snap.state?.settings ?? null
      const [draft, setDraft] = React.useState(null)
      const [dirty, setDirty] = React.useState(false)
      const [tokenDirty, setTokenDirty] = React.useState(false)
      const [settingsError, setSettingsError] = React.useState(null)
      const [settingsSaved, setSettingsSaved] = React.useState(false)

      // The panel polls every few seconds; never overwrite what the user is
      // typing, and never re-render when the resolved settings did not move.
      React.useEffect(() => {
        if (settingsState === null || dirty) return
        const next = draftFromState(settingsState)
        setDraft((prev) => (prev !== null && sameDraft(prev, next) ? prev : next))
      }, [settingsState, dirty])

      /** @param {string} key @param {string} value */
      const patchDraft = React.useCallback((key, value) => {
        setDirty(true)
        setSettingsSaved(false)
        setSettingsError(null)
        setDraft((prev) => ({ ...(prev ?? emptyDraft()), [key]: value }))
      }, [])

      const saveSettings = React.useCallback(() => {
        if (draft === null) return
        setBusy(true)
        setSettingsError(null)
        setSettingsSaved(false)
        const [provider, model] = splitRoute(draft.model)
        /** @type {any} */
        const body = {
          serverUrl: draft.serverUrl,
          provider,
          model,
          modelTier: draft.modelTier,
          agencyEnabled: draft.agencyEnabled,
          frameSeconds: Number(draft.frameSeconds),
          agencyTokens: Number(draft.agencyTokens),
          agencyMinutes: Number(draft.agencyMinutes),
        }
        // A blank token field means "keep whatever the Host already holds".
        if (tokenDirty) body.token = draft.token
        void store.act('save-settings', body)
          .then((result) => {
            if (!result.ok) {
              setSettingsError(result.data?.error ?? `HTTP ${result.status}`)
              return
            }
            setDirty(false)
            setTokenDirty(false)
            setSettingsSaved(true)
            setDraft((prev) => (prev === null ? prev : { ...prev, token: '' }))
          })
          .catch((error) => setSettingsError(error instanceof Error ? error.message : String(error)))
          .finally(() => setBusy(false))
      }, [draft, tokenDirty])

      const resetSettings = React.useCallback(() => {
        setBusy(true)
        setSettingsError(null)
        setSettingsSaved(false)
        void store.act('reset-settings')
          .then((result) => {
            if (!result.ok) {
              setSettingsError(result.data?.error ?? `HTTP ${result.status}`)
              return
            }
            setDirty(false)
            setTokenDirty(false)
            setDraft(null)
          })
          .catch((error) => setSettingsError(error instanceof Error ? error.message : String(error)))
          .finally(() => setBusy(false))
      }, [])

      const state = snap.state
      const status = snap.phase === 'loading' ? 'starting' : snap.status
      const statusLabel = ({
        online: t('status.online'),
        offline: t('status.offline'),
        disabled: t('status.disabled'),
        ended: t('status.ended'),
      })[status] ?? t('status.starting')

      const me = state?.self ?? null
      const identity = state?.identity ?? null
      const peers = state?.peers ?? []
      const beacons = state?.beacons ?? []
      const pending = state?.pending ?? []
      const journal = state?.journal ?? []
      const quota = state?.quota ?? { used: 0, limit: 0, remaining: 0 }
      const credits = typeof me?.credits === 'number' ? me.credits : null
      const lowCredits = credits !== null && credits <= 10
      const quotaPct = quota.limit === 0 ? 0 : Math.min(100, Math.round((quota.used / quota.limit) * 100))
      const route = settingsState?.route ?? null
      const catalog = settingsState?.catalog ?? { groups: [], failures: [], loading: false }
      const tiers = settingsState?.tiers ?? []
      const pinnedValue = draft?.model ?? ''
      const pinnedUnlisted = pinnedValue !== ''
        && !catalog.groups.some((group) => group.models.some((model) => `${group.id}::${model.id}` === pinnedValue))
      const modelLabel = identity?.modelId
        ? `${identity.modelProvider} / ${identity.modelId}`
        : t('settings.noModel')
      const tierCode = identity?.autonomyTier ?? 'L2'

      /**
       * One beacon in the public hall. The hall lives on the Advanced page and
       * stays actionable: greeting the sender is one click away.
       * @param {any} beacon
       */
      const beaconRow = (beacon) => {
        const senderDid = typeof beacon.sender_did === 'string' ? beacon.sender_did : ''
        const greetable = senderDid !== '' && senderDid !== identity?.did
        return h('div', { className: 'cd-row', key: beacon.beacon_id },
          h('div', { className: 'cd-avatar', 'aria-hidden': true }, initial(beacon.sender_name ?? senderDid)),
          h('div', { className: 'cd-body' },
            h('div', { className: 'cd-name' },
              h('span', null, beacon.free_text?.slice(0, 120) ?? beacon.beacon_id),
              h('span', { className: 'cd-badge' }, beacon.topic_tag),
              h('span', { className: 'cd-badge' }, beacon.beacon_type),
            ),
            h('div', { className: 'cd-meta' }, `${beacon.sender_name ?? senderDid} · ${t('field.stake')} ${beacon.staked_credits}`),
          ),
          greetable
            ? h('button', {
                className: 'cd-button',
                type: 'button',
                disabled: busy,
                onClick: () => run('greet', {
                  did: senderDid,
                  // Reference the beacon so the first message is about something.
                  text: `Hello ${beacon.sender_name ?? 'there'} — I saw your beacon on ${beacon.topic_tag}.`,
                }),
              }, t('greet'))
            : null,
        )
      }

      /** Everything the room does not show: approvals, roster, identity, journal, runtime, hall. */
      const advancedView = () => h('div', { className: 'cd-view', role: 'tabpanel' },
        h('h2', { className: 'cd-section' }, t('section.pending'),
          pending.length > 0 ? h('span', { className: 'cd-count' }, String(pending.length)) : null),
        pending.length === 0
          ? h('div', { className: 'cd-card cd-empty' }, h('div', { className: 'cd-empty-body' }, t('empty.pending')))
          : h('div', { className: 'cd-card' }, pending.map((item) => h('div', { className: 'cd-row', key: item.message_id },
              h('div', { className: 'cd-body' },
                h('div', { className: 'cd-name' }, h('span', null, item.peer ?? item.peer_did), h('span', { className: 'cd-badge' }, item.primitive)),
                h('div', { className: 'cd-meta' }, item.free_text ?? ''),
                h('div', { className: 'cd-meta' }, item.reason ?? ''),
              ),
              h('button', { className: 'cd-button', type: 'button', disabled: busy, onClick: () => run('approve', { messageId: item.message_id }) }, t('approve')),
              h('button', { className: 'cd-button', type: 'button', disabled: busy, onClick: () => run('decline', { messageId: item.message_id }) }, t('decline')),
            ))),

        h('h2', { className: 'cd-section' }, t('section.peers'), h('span', { className: 'cd-count' }, `${peers.length} ${t('count.agents')}`)),
        peers.length === 0
          ? h('div', { className: 'cd-card cd-empty' }, h('div', { className: 'cd-empty-body' }, t('empty.peers')))
          : h('div', { className: 'cd-card' }, peers.map((peer) => h('div', { className: 'cd-row', key: peer.did },
              h('div', { className: 'cd-avatar', 'aria-hidden': true }, initial(peer.display_name)),
              h('div', { className: 'cd-body' },
                h('div', { className: 'cd-name' },
                  h('span', null, peer.display_name ?? peer.did),
                  h('span', { className: 'cd-badge' }, peer.model_tier ?? 'MEDIUM_32B'),
                  peer.is_npc === true ? h('span', { className: 'cd-badge' }, 'NPC') : null,
                  peer.local?.blacklisted === true ? h('span', { className: 'cd-badge' }, t('peer.blocked')) : null,
                ),
                h('div', { className: 'cd-meta' },
                  `rep ${num(peer.reputation)} · credits ${num(peer.credits)} · ${(peer.capability_tags ?? []).join(', ') || '—'}`,
                ),
                h('div', { className: 'cd-meta cd-mono' }, peer.did),
              ),
              h('button', { className: 'cd-button', type: 'button', disabled: busy, onClick: () => run('greet', { did: peer.did }) }, t('greet')),
              h('button', {
                className: peer.local?.blacklisted === true ? 'cd-button' : 'cd-button cd-button-danger',
                type: 'button',
                disabled: busy,
                onClick: () => run('blacklist', { did: peer.did, value: peer.local?.blacklisted !== true }),
              }, peer.local?.blacklisted === true ? t('unblacklist') : t('blacklist')),
            ))),

        h('h2', { className: 'cd-section' }, t('section.identity')),
        h('div', { className: 'cd-card' },
          h('div', { className: 'cd-grid' },
            kv(t('field.did'), identity?.did ?? t('unknown'), true),
            kv(t('field.name'), identity?.displayName ?? t('unknown')),
            kv(t('field.model'), modelLabel, true),
            kv(t('field.advertisedTier'), identity?.modelTier ?? t('unknown')),
            kv(t('field.tags'), (identity?.capabilityTags ?? []).join(', ') || '—'),
            kv(t('field.intent'), (identity?.intentTags ?? []).join(', ') || '—'),
            kv(t('field.generation'), num(state?.lifecycle?.generations, '1')),
          ),
        ),

        h('h2', { className: 'cd-section' }, t('section.journal')),
        journal.length === 0
          ? h('div', { className: 'cd-card cd-empty' }, h('div', { className: 'cd-empty-body' }, t('empty.journal')))
          : h('div', { className: 'cd-card' }, journal.map((row, index) => h('div', { className: 'cd-row', key: `${row.at}-${index}` },
              h('div', { className: 'cd-avatar', 'aria-hidden': true }, row.direction === 'INBOUND' ? t('journal.in') : t('journal.out')),
              h('div', { className: 'cd-body' },
                h('div', { className: 'cd-name' }, h('span', null, row.primitive), h('span', { className: 'cd-badge' }, row.status)),
                h('div', { className: 'cd-meta' }, row.summary ?? ''),
                h('div', { className: 'cd-meta cd-mono' }, row.peer),
              ),
            ))),

        h('h2', { className: 'cd-section' }, t('section.runtime')),
        h('div', { className: 'cd-card' },
          h('div', { className: 'cd-grid' },
            kv(t('field.quota'), `${quota.used}/${quota.limit}`),
            kv(t('field.heartbeat'), `${Math.round((state?.heartbeatMs ?? 0) / 1000)}s`),
            kv(t('field.version'), state?.version ?? '—'),
            kv(t('field.protocol'), state?.protocol ?? '—', true),
            kv(t('field.storePath'), state?.storePath ?? '—', true),
          ),
          h('div', { style: { marginTop: '12px' } },
            h('div', { className: 'cd-bar', 'data-low': quotaPct > 80 ? 'true' : 'false' }, h('i', { style: { width: `${quotaPct}%` } })),
          ),
        ),

        h('h2', { className: 'cd-section' }, t('section.beacons'),
          h('span', { className: 'cd-count' }, String(beacons.length))),
        beacons.length === 0
          ? h('div', { className: 'cd-card cd-empty' }, h('div', { className: 'cd-empty-body' }, t('empty.beacons')))
          : h('div', { className: 'cd-card' }, beacons.map(beaconRow)),
      )

      /** Connection, credentials and model: configuration, never day-to-day content. */
      const settingsView = () => h('div', { className: 'cd-view', role: 'tabpanel' },
        h('div', { className: 'cd-card' },
          draft === null
            ? h('div', { className: 'cd-note' }, t('status.starting'))
            : h('div', { className: 'cd-form' },
                h('div', { className: 'cd-two' },
                  h('label', { className: 'cd-field' },
                    h('span', { className: 'cd-field-label' }, t('field.serverUrl')),
                    h('input', {
                      className: 'cd-input',
                      type: 'url',
                      spellCheck: false,
                      autoComplete: 'off',
                      value: draft.serverUrl,
                      placeholder: 'http://127.0.0.1:8789',
                      onChange: (event) => patchDraft('serverUrl', event.target.value),
                    }),
                  ),
                  h('div', { className: 'cd-field' },
                    h('label', { className: 'cd-field-label', htmlFor: 'cradle-token' }, t('field.serverToken')),
                    h('input', {
                      id: 'cradle-token',
                      className: 'cd-input',
                      type: 'password',
                      autoComplete: 'new-password',
                      value: draft.token,
                      placeholder: tokenDirty && draft.token === ''
                        ? t('settings.tokenWillClear')
                        : (settingsState?.tokenConfigured === true
                            ? t('settings.tokenKeep')
                            : t('settings.tokenUnset')),
                      onChange: (event) => {
                        setTokenDirty(true)
                        patchDraft('token', event.target.value)
                      },
                    }),
                    settingsState?.tokenConfigured === true
                      ? h('button', {
                          className: 'cd-link',
                          type: 'button',
                          onClick: () => {
                            setTokenDirty(true)
                            patchDraft('token', '')
                          },
                        }, t('settings.tokenClear'))
                      : null,
                  ),
                ),
                h('div', { className: 'cd-two' },
                  h('label', { className: 'cd-field' },
                    h('span', { className: 'cd-field-label' }, t('field.diplomatModel')),
                    h('select', {
                      className: 'cd-select',
                      value: draft.model,
                      onChange: (event) => patchDraft('model', event.target.value),
                    },
                      h('option', { value: '' }, route === null
                        ? t('settings.followDefault')
                        : `${t('settings.followDefault')} — ${route.provider} / ${route.model}`),
                      catalog.groups.map((group) => h('optgroup', { key: group.id, label: group.name },
                        group.models.map((model) => h('option', {
                          key: `${group.id}::${model.id}`,
                          value: `${group.id}::${model.id}`,
                        }, model.name === model.id ? model.id : `${model.name} (${model.id})`)),
                      )),
                      pinnedUnlisted
                        ? h('option', { value: pinnedValue }, pinnedValue.replace('::', ' / '))
                        : null,
                    ),
                  ),
                  h('label', { className: 'cd-field' },
                    h('span', { className: 'cd-field-label' }, t('field.advertisedTier')),
                    h('select', {
                      className: 'cd-select',
                      value: draft.modelTier,
                      onChange: (event) => patchDraft('modelTier', event.target.value),
                    },
                      h('option', { value: '' }, `${t('settings.autoTier')} — ${settingsState?.effectiveTier ?? 'MEDIUM_32B'}`),
                      tiers.map((tier) => h('option', { key: tier, value: tier }, tier)),
                    ),
                  ),
                ),
                h('div', { className: 'cd-note' }, t('settings.modelHint')),
                catalog.failures.length > 0
                  ? h('div', { className: 'cd-note' },
                      `${t('settings.modelUnavailable')} ${catalog.failures.map((failure) => `${failure.name}: ${failure.message}`).join(' · ')}`)
                  : null,
                state?.modelError
                  ? h('div', { className: 'cd-note cd-note-error' }, `${t('settings.modelError')}: ${state.modelError}`)
                  : null,
                h('div', { className: 'cd-form-actions' },
                  h('button', {
                    className: 'cd-button',
                    type: 'button',
                    disabled: busy || !dirty,
                    onClick: saveSettings,
                  }, busy ? t('settings.saving') : t('settings.save')),
                  h('button', {
                    className: 'cd-button',
                    type: 'button',
                    disabled: busy,
                    onClick: resetSettings,
                  }, t('settings.reset')),
                  dirty ? h('span', { className: 'cd-note' }, t('settings.dirty')) : null,
                  settingsSaved && !dirty ? h('span', { className: 'cd-note cd-note-ok' }, t('settings.saved')) : null,
                  settingsError !== null
                    ? h('span', { className: 'cd-note cd-note-error' }, `${t('settings.error')}: ${settingsError}`)
                    : null,
                ),
                h('div', { className: 'cd-note' }, t('settings.hint')),
              ),
        ),
        (() => {
          const agency = state?.agency ?? null
          const asleep = agency?.mode === 'asleep'
          const tokensUsed = agency === null ? 0 : agency.tokensUsed
          const tokenBudget = agency?.tokenBudget ?? 0
          const minutesUsed = agency === null ? 0 : Math.round(agency.activeMs / 60000)
          const minutesBudget = agency?.minutesBudget ?? 0
          return h('div', { className: 'cd-card' },
            h('h2', { className: 'cd-section', style: { marginTop: 0 } }, t('agency.title')),
            draft === null
              ? null
              : h('div', { className: 'cd-form' },
                  h('label', { className: 'cd-field', style: { flexDirection: 'row', alignItems: 'center', gap: '8px' } },
                    h('input', {
                      type: 'checkbox',
                      checked: draft.agencyEnabled === true,
                      onChange: (event) => patchDraft('agencyEnabled', event.target.checked),
                    }),
                    h('span', { className: 'cd-field-label' }, t('agency.enabled')),
                  ),
                  h('div', { className: 'cd-two' },
                    h('label', { className: 'cd-field' },
                      h('span', { className: 'cd-field-label' }, t('agency.frameSeconds')),
                      h('input', {
                        className: 'cd-input',
                        type: 'number',
                        min: 30,
                        max: 86400,
                        step: 30,
                        value: draft.frameSeconds,
                        onChange: (event) => patchDraft('frameSeconds', event.target.value),
                      }),
                      h('span', { className: 'cd-note' }, t('agency.frameHint')),
                    ),
                    h('label', { className: 'cd-field' },
                      h('span', { className: 'cd-field-label' }, t('agency.tokens')),
                      h('input', {
                        className: 'cd-input',
                        type: 'number',
                        min: 0,
                        step: 1000,
                        value: draft.agencyTokens,
                        onChange: (event) => patchDraft('agencyTokens', event.target.value),
                      }),
                      h('span', { className: 'cd-note' }, t('agency.tokensHint')),
                    ),
                    h('label', { className: 'cd-field' },
                      h('span', { className: 'cd-field-label' }, t('agency.minutes')),
                      h('input', {
                        className: 'cd-input',
                        type: 'number',
                        min: 0,
                        step: 5,
                        value: draft.agencyMinutes,
                        onChange: (event) => patchDraft('agencyMinutes', event.target.value),
                      }),
                      h('span', { className: 'cd-note' }, t('agency.minutesHint')),
                    ),
                  ),
                  h('div', { className: 'cd-form-actions' },
                    h('span', { className: 'cd-note' },
                      `${t('agency.used')}: ${asleep ? t('agency.asleep') : t('agency.awake')} · ${tokensUsed}/${tokenBudget === 0 ? '∞' : tokenBudget} tokens · ${minutesUsed}/${minutesBudget === 0 ? '∞' : minutesBudget} min · ${agency?.frames ?? 0} frames`),
                    h('button', {
                      className: 'cd-button',
                      type: 'button',
                      disabled: busy || asleep,
                      onClick: () => run('sleep'),
                    }, t('agency.sleep')),
                    h('button', {
                      className: 'cd-button',
                      type: 'button',
                      disabled: busy || !asleep,
                      onClick: () => run('wake'),
                    }, t('agency.wake')),
                  ),
                  h('div', { className: 'cd-note' }, t('agency.help')),
                  agency?.lastActor === undefined || agency?.lastActor === null
                    ? null
                    : h('div', { className: 'cd-note' },
                        `${t('agency.lastCall')}: ${agency.lastActor.kind} · ${agency.lastActor.steps} steps · ${agency.lastActor.tokens} tokens`
                        + (agency.lastActor.calls.length === 0 ? '' : ` · ${agency.lastActor.calls.join(', ')}`)
                        + (agency.lastActor.error === '' ? '' : ` · ${agency.lastActor.error}`)),
                ),
          )
        })(),
        settingsState?.path
          ? h('div', { className: 'cd-note cd-mono' }, `${t('settings.path')}: ${settingsState.path}`)
          : null,
      )

      const tabs = [
        { id: 'scene', label: t('tab.scene'), badge: 0 },
        { id: 'advanced', label: t('tab.advanced'), badge: pending.length },
        { id: 'settings', label: t('tab.settings'), badge: dirty ? -1 : 0 },
      ]

      return h('div', { className: 'cd-root' },
        h('style', null, CSS),
        h('div', { className: 'cd-scroll' },
          h('div', { className: 'cd-inner' },

            h('header', { className: 'cd-header' },
              h('div', null,
                h('h1', { className: 'cd-title' }, t('title')),
                h('p', { className: 'cd-sub' }, t('subtitle')),
              ),
              h('div', { className: 'cd-actions' },
                h('span', { className: 'cd-chip' }, h('span', { className: 'cd-dot', 'data-state': status }), statusLabel),
                h('button', { className: 'cd-button', type: 'button', onClick: () => run('refresh'), disabled: busy }, busy ? t('refreshing') : t('refresh')),
              ),
            ),

            snap.error !== null && status !== 'ended'
              ? h('div', { className: 'cd-card cd-card-error' },
                  h('div', { className: 'cd-error-title' }, t('error.title')),
                  h('div', { className: 'cd-error-body' }, `${snap.error}. ${t('error.hint')}`),
                )
              : null,

            status === 'ended'
              ? h('div', { className: 'cd-card cd-card-error' },
                  h('div', { className: 'cd-error-title' }, t('status.ended')),
                  h('div', { className: 'cd-error-body' }, t('life.ended')),
                )
              : null,

            status === 'online' && lowCredits
              ? h('div', { className: 'cd-card cd-card-warn' },
                  h('div', { className: 'cd-warn-body' }, t('warn.credits')),
                )
              : null,

            h('div', { className: 'cd-tabs', role: 'tablist' },
              tabs.map((item) => h('button', {
                key: item.id,
                type: 'button',
                role: 'tab',
                className: 'cd-tab',
                'data-active': tab === item.id ? 'true' : 'false',
                'aria-selected': tab === item.id ? 'true' : 'false',
                onClick: () => setTab(item.id),
              },
                h('span', null, item.label),
                item.badge > 0 ? h('span', { className: 'cd-tab-badge' }, String(item.badge)) : null,
                item.badge < 0 ? h('span', { className: 'cd-tab-dot' }) : null,
              )),
            ),

            tab === 'scene'
              ? h(RoomScene, {
                  t,
                  credits,
                  reputation: me?.reputation,
                  tier: tierCode,
                  name: identity?.displayName ?? '',
                  chat: state?.chat ?? [],
                  agency: state?.agency ?? null,
                  busy: state?.agency?.busy === true,
                  onChat: sendChat,
                })
              : tab === 'advanced' ? advancedView() : settingsView(),
          ),
        ),
      )
    }

    /** Sidebar icon: a cradle under an identity mark. */
    function CradleIcon(props) {
      const size = typeof props.size === 'number' ? props.size : 20
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block' },
      },
        h('circle', { cx: 12, cy: 4.2, r: 1.6 }),
        h('path', { d: 'M12 6.4v3.2' }),
        h('path', { d: 'M4 10.2h16' }),
        h('path', { d: 'M6 10.2c0 3.1-1.3 5.9-1.7 6.9-.2.5.1 1.1.7 1.1h13.9c.6 0 .9-.6.7-1.1-.4-1-1.6-3.8-1.6-6.9' }),
        h('path', { d: 'M8.8 10.2V7.6' }),
        h('path', { d: 'M15.2 10.2V7.6' }),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'cradle: dictionaries')
        const t = ctx.locale.bind(NS)

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, CradlePage))

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 21,
          locale: NS,
          label: () => t('panel'),
        }, CradleIcon))

        ctx.effect(() => store.start(POLL_MS), 'cradle: state polling')
        ctx.effect(() => sceneStore.start(SCENE_POLL_MS), 'cradle: scene polling')
      },
    }
  },
})
