import { createElement as h, useEffect, useRef, useState } from 'react'
import { stripHeader } from './text.js'
import { MicIcon, CloseIcon } from './icons.js'
import { BotMark, RoomAvatar } from './mark.js'
import { speechApi, useDictation } from './composer.js'
import { Shimmer } from './cells.js'
import { useEscape } from './overlay-hooks.js'
import { t } from './i18n.js'
import { openCapture, preparationStep, speechCatalog, transcribeWave, turnDetector } from './speech.js'
import { openLiveVoiceSession } from './voice-live.js'
import { runtimeOf } from './runtime-pill.js'

// Voice chat: defaults to OpenAI GPT-Live 1.1 WebRTC (with Standby and client
// delegation to DS Bot) across both Local and Cloud bots, falling back to DSH's
// Voice Input plugin or browser speech recognition/synthesis when unavailable.
const plainSpeech = text => stripHeader(text).replace(/```[\s\S]*?```/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`#>|~-]+/g, ' ').replace(/\s+/g, ' ').trim()
const VOICE_LABELS = {
  connecting: 'Connecting…', listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking', standby: 'Standby', paused: 'Paused',
  setup: 'Voice input needs its speech model', preparing: 'Preparing voice input…',
  unsupported: 'Voice chat is not available in this browser',
}
const CAPTURE_NOTES = { blocked: 'Microphone access is blocked', unavailable: 'Voice chat is not available in this browser', 'too-long': 'That was too long to recognize' }

// Reads the reply until it lands, then consumes it once. The chat target can
// publish synchronously inside `watch`, before it returns the disposer, so the
// consumed flag — not the disposer — is what stops a second pass: a reply
// already spoken is never spoken again.
export function watchReply(read, watch, consume) {
  let off = () => {}
  let consumed = false
  const attempt = () => {
    if (consumed) return
    const text = read()
    if (text === undefined) return
    consumed = true
    off()
    consume(text)
  }
  off = watch(attempt)
  attempt()
  return () => { consumed = true; off() }
}

function useMicLevel(enabled) {
  const [level, setLevel] = useState(0)
  useEffect(() => {
    if (!enabled || !navigator.mediaDevices?.getUserMedia) return undefined
    let stream = null
    let audio = null
    let frame = 0
    let stopped = false
    navigator.mediaDevices.getUserMedia({ audio: true }).then((media) => {
      if (stopped) { media.getTracks().forEach(track => track.stop()); return }
      stream = media
      audio = new AudioContext()
      const analyser = audio.createAnalyser()
      analyser.fftSize = 256
      audio.createMediaStreamSource(media).connect(analyser)
      const data = new Uint8Array(analyser.frequencyBinCount)
      let smooth = 0
      const tick = () => {
        analyser.getByteTimeDomainData(data)
        let sum = 0
        for (const value of data) sum += ((value - 128) / 128) ** 2
        smooth = smooth * 0.8 + Math.min(1, Math.sqrt(sum / data.length) * 4) * 0.2
        setLevel(Math.round(smooth * 100) / 100)
        frame = requestAnimationFrame(tick)
      }
      tick()
    }).catch(() => {})
    return () => {
      stopped = true
      cancelAnimationFrame(frame)
      stream?.getTracks().forEach(track => track.stop())
      void audio?.close().catch(() => {})
      setLevel(0)
    }
  }, [enabled])
  return level
}

export function VoiceMode({ sessionId, paneLeft, roster, actions, useSessions, useSessionStatus }) {
  const bot = roster.byId[sessionId]
  const room = roster.roomsById[sessionId]
  const name = bot?.name ?? room?.name ?? t('Bot')
  const runtime = runtimeOf(roster, sessionId)
  const running = useSessionStatus(map => map.get(sessionId)?.running === true)
  const lastReply = useSessions((list) => {
    const outline = list.projectionsBySession?.[sessionId]?.values?.turnOutline ?? list.byId[sessionId]?.projectionValues?.turnOutline
    const entry = Array.isArray(outline) ? outline[outline.length - 1] : undefined
    return entry ? `${outline.length}|${entry.turn}` : '0|'
  })
  // The Voice Input plugin's Remote, read once: the engine does not change mid-chat.
  const [speech] = useState(() => actions.speech())
  const hasVoiceStatus = typeof actions.voiceStatus === 'function'
  const [engine, setEngine] = useState(() => (hasVoiceStatus ? 'probing' : 'legacy'))
  const [liveMeta, setLiveMeta] = useState(null)
  const [phase, setPhase] = useState(() => (hasVoiceStatus ? 'starting' : (speech ? 'starting' : speechApi() ? 'listening' : 'unsupported')))
  const [catalog, setCatalog] = useState(null)
  const [heard, setHeard] = useState('')
  const [said, setSaid] = useState('')
  const [note, setNote] = useState('')
  const [serviceLevel, setServiceLevel] = useState(0)
  const [cycle, setCycle] = useState(0)
  const waiting = useRef(null)
  const reply = useRef(lastReply)
  reply.current = lastReply
  const liveRef = useRef(null)
  const pendingDelegation = useRef(null)
  const prevLocation = useRef(runtime.location)
  // Bumped on pause and close, so a transcript that arrives later is dropped.
  const turn = useRef(0)
  const close = () => {
    turn.current += 1
    liveRef.current?.close()
    liveRef.current = null
    pendingDelegation.current = null
    window.speechSynthesis?.cancel()
    actions.closeVoice()
  }
  useEscape(close)
  const submit = (text) => {
    setHeard(text)
    setPhase('thinking')
    waiting.current = reply.current.split('|')[0]
    void actions.send(sessionId, text.trim()).catch(() => setPhase('listening'))
  }
  const dictation = useDictation((text, final) => {
    setHeard(text)
    if (!final) return
    dictation.stop()
    submit(text)
  })
  useEffect(() => {
    if (!hasVoiceStatus) return undefined
    let alive = true
    const canWebRtc = typeof RTCPeerConnection === 'function' && Boolean(navigator.mediaDevices?.getUserMedia)
    void Promise.resolve(actions.voiceStatus(sessionId)).then((status) => {
      if (!alive) return
      if (status?.available === true && canWebRtc) {
        setLiveMeta(status)
        setEngine('live')
        setPhase('connecting')
      } else {
        setEngine('legacy')
        setPhase(speech ? 'starting' : speechApi() ? 'listening' : 'unsupported')
      }
    }, () => {
      if (!alive) return
      setEngine('legacy')
      setPhase(speech ? 'starting' : speechApi() ? 'listening' : 'unsupported')
    })
    return () => { alive = false }
  }, [sessionId])
  useEffect(() => {
    if (engine !== 'live') return undefined
    let disposed = false
    setPhase('connecting')
    void openLiveVoiceSession({
      sessionId,
      model: liveMeta?.model,
      voice: liveMeta?.defaultVoice,
      idleTimeoutS: liveMeta?.standby?.idleTimeoutS,
      vadThreshold: liveMeta?.standby?.vadThreshold,
      createSession: actions.voiceSessionCreate,
      closeSession: actions.voiceSessionClose,
      onPhase: (next) => {
        if (disposed) return
        setPhase(curr => (curr === 'paused' || curr === 'thinking' ? curr : next))
      },
      onTranscript: ({ role, text }) => {
        if (disposed) return
        if (role === 'user') setHeard(text)
        else setSaid(text)
      },
      onTranscriptCommit: ({ role, text }) => {
        if (disposed || !text) return
        void actions.voiceTranscriptAppend?.(sessionId, role, text)
      },
      onLevel: (value) => { if (!disposed) setServiceLevel(value) },
      onDelegation: ({ delegationId, query }) => {
        if (disposed || !query) return
        pendingDelegation.current = delegationId ?? null
        submit(query)
      },
      onError: (msg) => {
        if (disposed) return
        setNote(typeof msg === 'string' && msg ? msg : t("Couldn't connect voice session"))
        setPhase('paused')
      },
    }).then((session) => {
      if (disposed) { session.close(); return }
      liveRef.current = session
      setLiveMeta(session.meta ?? liveMeta)
    }).catch((error) => {
      if (disposed) return
      const msg = error?.kind === 'blocked'
        ? t(CAPTURE_NOTES.blocked)
        : error?.kind === 'unavailable'
          ? t(CAPTURE_NOTES.unavailable)
          : (error?.message || t("Couldn't connect voice session"))
      setNote(msg)
      setPhase('paused')
    })
    return () => {
      disposed = true
      const current = liveRef.current
      liveRef.current = null
      pendingDelegation.current = null
      current?.close()
    }
  }, [engine, sessionId])
  useEffect(() => {
    if (engine !== 'live') {
      prevLocation.current = runtime.location
      return
    }
    if (prevLocation.current === runtime.location) return
    prevLocation.current = runtime.location
    liveRef.current?.sendEvent({
      type: 'session.instructions.append',
      event_id: `evt_${Date.now().toString(36)}`,
      delegation_id: null,
      content: runtime.location === 'cloud'
        ? `Runtime update: this Bot is now handed off to Cloud machine "${runtime.machineName ?? runtime.machineId ?? 'AWS'}".`
        : 'Runtime update: this Bot is now running back on the Local machine.',
    })
  }, [engine, runtime.location, runtime.machineId, runtime.machineName])
  useEffect(() => {
    if (!note) return undefined
    const timer = setTimeout(() => setNote(''), 2600)
    return () => clearTimeout(timer)
  }, [note])
  useEffect(() => {
    if (engine !== 'legacy' || !speech) return undefined
    let live = true
    speechCatalog(speech).then(({ catalog: next, usable }) => {
      if (!live) return
      setCatalog(next)
      setPhase(usable ? 'listening' : 'setup')
    }, () => { if (live) setPhase('setup') })
    return () => { live = false }
  }, [engine, speech])
  const listen = phase === 'listening'
  useEffect(() => {
    if (engine !== 'legacy' || speech || !listen || dictation.listening) return undefined
    const timer = setTimeout(() => dictation.start({ continuous: false, onEnd: () => {} }), 250)
    return () => clearTimeout(timer)
  }, [engine, listen, dictation.listening])
  // Recognition stops on silence; keep listening until the user pauses or ends.
  useEffect(() => {
    if (engine === 'legacy' && phase !== 'listening') dictation.stop()
  }, [engine, phase])
  // The plugin's recognizer: record one utterance, end it after a pause, transcribe it.
  useEffect(() => {
    if (engine !== 'legacy' || !speech || !catalog || !listen) return undefined
    const own = turn.current
    let capture = null
    let frame = 0
    let stopped = false
    let smooth = 0
    const detect = turnDetector()
    const limit = Math.max(1, catalog.maxDurationSeconds - 1) * 1000
    const finish = async (current) => {
      setPhase('transcribing')
      try {
        const wave = await current.finish(catalog.maxDurationSeconds)
        const text = wave ? await transcribeWave(speech, catalog, wave, new AbortController().signal) : ''
        if (turn.current !== own) return
        if (text) submit(text)
        else setPhase('listening')
      } catch (error) {
        if (turn.current !== own) return
        setNote(t(CAPTURE_NOTES[error?.kind] ?? "Couldn't hear that"))
        setPhase('listening')
      }
    }
    openCapture().then((opened) => {
      if (stopped) { opened.cancel(); return }
      capture = opened
      const began = performance.now()
      const tick = () => {
        const now = performance.now()
        const level = capture.level()
        smooth = smooth * 0.8 + level * 0.2
        setServiceLevel(Math.round(smooth * 100) / 100)
        const state = detect(level, now)
        if (state === 'done' || (state === 'speech' && now - began >= limit)) {
          const current = capture
          capture = null
          setServiceLevel(0)
          void finish(current)
          return
        }
        // Nothing said for a whole recording: start a fresh one.
        if (state === 'waiting' && now - began >= limit) { setCycle(value => value + 1); return }
        frame = requestAnimationFrame(tick)
      }
      tick()
    }, (error) => {
      if (stopped) return
      setNote(t(CAPTURE_NOTES[error?.kind] ?? "Couldn't hear that"))
      setPhase('paused')
    })
    return () => {
      stopped = true
      cancelAnimationFrame(frame)
      capture?.cancel()
      setServiceLevel(0)
    }
  }, [engine, speech, catalog, listen, cycle])
  useEffect(() => {
    if (phase !== 'thinking' || running || waiting.current === null) return undefined
    const count = lastReply.slice(0, lastReply.indexOf('|'))
    const turn = Number(lastReply.slice(lastReply.indexOf('|') + 1))
    if (count === waiting.current) return undefined
    const speak = (text) => {
      waiting.current = null
      if (engine === 'live' && liveRef.current) {
        const delegationId = pendingDelegation.current
        pendingDelegation.current = null
        setHeard('')
        setPhase('listening')
        liveRef.current.sendCommentary(delegationId, text)
        return
      }
      const spoken = plainSpeech(text)
      setSaid(spoken)
      setHeard('')
      if (!window.speechSynthesis || !spoken) { setPhase('listening'); return }
      const utterance = new SpeechSynthesisUtterance(spoken)
      utterance.lang = /[\u3400-\u9fff]/.test(spoken) ? 'zh-CN' : 'en-US'
      utterance.onend = () => setPhase(current => (current === 'speaking' ? 'listening' : current))
      utterance.onerror = utterance.onend
      setPhase('speaking')
      window.speechSynthesis.cancel()
      window.speechSynthesis.speak(utterance)
    }
    // The outline commits at turn/end but only holds a bounded preview; the
    // closing Assistant text can trail it, so the answer is read through the
    // chat view's own changes until it lands (or the Session goes away).
    return watchReply(
      () => actions.closingReply(sessionId, turn),
      listener => actions.watchTurns(sessionId, listener),
      (text) => {
        if (text === null) {
          waiting.current = null
          pendingDelegation.current = null
          setPhase('listening')
          return
        }
        speak(text)
      })
  }, [phase, running, lastReply, engine])
  useEffect(() => () => window.speechSynthesis?.cancel(), [])
  const micLevel = useMicLevel(engine === 'legacy' && !speech && phase === 'listening' && dictation.listening)
  const level = engine === 'live' || speech ? serviceLevel : micLevel
  const markState = phase === 'thinking' || phase === 'transcribing' || phase === 'connecting' ? 'thinking' : phase === 'speaking' ? 'sending' : 'idle'
  const blocked = phase === 'unsupported' || phase === 'setup' || phase === 'starting' || phase === 'preparing' || phase === 'connecting'
  const togglePause = () => {
    if (engine === 'live') {
      if (phase === 'paused') {
        liveRef.current?.setMuted(false)
        setPhase('listening')
      } else {
        liveRef.current?.setMuted(true)
        setPhase('paused')
      }
      return
    }
    if (phase === 'paused') { setPhase('listening'); return }
    turn.current += 1
    window.speechSynthesis?.cancel()
    setPhase('paused')
  }
  // A 'preparing' phase follows the speech Remote's own catalog until the
  // provider is usable; the plugin-manager path navigates away instead.
  useEffect(() => {
    if (engine !== 'legacy' || phase !== 'preparing' || !speech) return undefined
    let stopped = false
    let timer
    const tick = async () => {
      try {
        const { catalog: next } = await speechCatalog(speech)
        if (stopped) return
        setCatalog(next)
        const step = preparationStep(next)
        if (step.state === 'usable') { setPhase('listening'); return }
        if (step.state === 'done') {
          setPhase('setup')
          if (step.failed) setNote(t("Couldn't prepare voice input"))
          return
        }
        setNote(step.pct === undefined ? '' : t('Downloading the speech model… {pct}%', { pct: step.pct }))
      } catch { if (!stopped) { setPhase('setup'); return } }
      timer = setTimeout(tick, 1500)
    }
    timer = setTimeout(tick, 800)
    return () => { stopped = true; clearTimeout(timer) }
  }, [phase, speech])
  const openSetup = phase === 'setup' ? actions.voiceSetup(catalog?.selection?.providerId) : null
  const startSetup = () => {
    if (openSetup?.navigate) { close(); openSetup.navigate(); return }
    turn.current += 1
    setPhase('preparing')
    void Promise.resolve(openSetup.prepare()).then((started) => {
      if (started === false) { setPhase('setup'); setNote(t("Couldn't prepare voice input")) }
    })
  }
  const caption = phase === 'speaking' ? said : heard
  const shownNote = note || dictation.note
  const modelBadge = liveMeta?.model === 'gpt-live-1' ? 'GPT-Live 1' : 'GPT-Live 1.1'
  const locationBadge = runtime.location === 'cloud' ? t('Cloud') : t('Local')
  const metaLabel = engine === 'live'
    ? `${modelBadge} · ${locationBadge}${phase === 'standby' ? ` · ${t('Standby')}` : ''}`
    : null
  return h('div', { className: 'bt-pane bt-voice-pane', style: { left: paneLeft } },
    h('div', { className: 'bt-voice-stage', role: 'dialog', 'aria-label': t('Voice chat with {name}', { name }), 'data-phase': phase === 'transcribing' || phase === 'connecting' ? 'thinking' : phase },
      h('div', { className: 'bt-voice-orb', style: { '--bt-level': level } },
        h('span', { className: 'bt-voice-ring', 'aria-hidden': true }),
        h('span', { className: 'bt-voice-ring bt-voice-ring-2', 'aria-hidden': true }),
        bot ? h(BotMark, { bot, size: 112, state: markState, live: true, gaze: phase === 'listening' }) : room ? h(RoomAvatar, { room, roster, size: 112 }) : null),
      h('div', { className: 'bt-voice-name' }, name),
      metaLabel ? h('div', { className: 'bt-voice-meta' }, metaLabel) : null,
      h('div', { className: 'bt-voice-status', role: 'status' },
        phase === 'thinking' ? h(Shimmer, null, t('Thinking…'))
          : phase === 'transcribing' ? h(Shimmer, null, t('Recognizing…'))
            : VOICE_LABELS[phase] ? t(VOICE_LABELS[phase]) : ''),
      h('div', { className: 'bt-voice-caption', key: `${phase}:${caption.slice(0, 12)}` }, caption),
      openSetup ? h('button', { type: 'button', className: 'bt-voice-setup', onClick: startSetup }, t('Set up voice input')) : null,
      shownNote ? h('div', { className: 'bt-voice-note' }, shownNote) : null),
    h('div', { className: 'bt-voice-bar' },
      h('button', {
        type: 'button', className: 'bt-voice-btn', 'aria-pressed': phase === 'paused', disabled: blocked,
        'aria-label': phase === 'paused' ? t('Resume listening') : t('Pause'), onClick: togglePause,
      }, h(MicIcon, { size: 20 }), phase === 'paused' ? h('span', { className: 'bt-voice-slash', 'aria-hidden': true }) : null),
      h('button', { type: 'button', className: 'bt-voice-btn bt-voice-end', 'aria-label': t('End voice chat'), onClick: close }, h(CloseIcon))))
}
